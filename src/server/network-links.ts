// Discover HTTP services that answer on this machine's local-network or Tailscale addresses.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { localServers } from "./browser/local-servers.ts";

export type LinkNetwork = "local" | "tailnet" | "server";

export type LinkHost = { network: LinkNetwork; host: string };
type ServiceLink = {
    network: LinkNetwork;
    host: string;
    url: string;
    secure?: boolean;
};
export type NetworkService = {
    port: number;
    title: string;
    links: ServiceLink[];
};

type Probe = (host: string, port: number) => Promise<{ title: string } | undefined>;
type ServedService = {
    port: number;
    backendPort: number;
    title: string;
    link: ServiceLink;
};
type Options = {
    hosts?: readonly LinkHost[];
    listeners?: ReadonlyMap<number, ReadonlySet<string>>;
    local?: readonly { port: number; url: string; title: string }[];
    served?: readonly ServedService[];
    probe?: Probe;
};

const execFileAsync = promisify(execFile);
const MAX_PORTS = 100;
const HTTPS_ONLY_RESPONSE = /plain HTTP request was sent to HTTPS port/i;

/** IPv4 addresses in Tailscale's CGNAT range, 100.64.0.0/10. */
function isTailnet(host: string): boolean {
    const [first, second] = host.split(".").map(Number);

    return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** The first usable address for each network; the link itself is checked before it is shown. */
function linkHosts(): LinkHost[] {
    const found = new Map<LinkNetwork, LinkHost>();

    for (const [name, interfaces] of Object.entries(networkInterfaces())) {
        for (const net of interfaces ?? []) {
            if (net.family !== "IPv4" || net.internal) {
                continue;
            }

            const network = isTailnet(net.address) || /tailscale/i.test(name) ? "tailnet" : "local";

            if (!found.has(network)) {
                found.set(network, { network, host: net.address });
            }
        }
    }

    return [...found.values()];
}

/** Decode Linux's little-endian IPv4 address in `/proc/net/tcp`. */
function ipv4(hex: string): string {
    return [6, 4, 2, 0].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(".");
}

/** Listener addresses that can match the network hosts, or `*` for a wildcard bind. Linux only. */
function listeningOn(hosts: readonly LinkHost[]): Map<number, Set<string>> {
    const result = new Map<number, Set<string>>();
    const knownHosts = new Set(hosts.map((each) => each.host));

    const add = (port: number, address: string) => {
        const entries = result.get(port) ?? new Set<string>();

        entries.add(address);
        result.set(port, entries);
    };

    for (const [file, ipv6] of [
        ["/proc/net/tcp", false],
        ["/proc/net/tcp6", true],
    ] as const) {
        let text: string;

        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }

        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);

            if (fields[3] !== "0A") {
                continue;
            }

            const [addressHex = "", portHex = ""] = (fields[1] ?? "").split(":");

            if (!/^[0-9A-F]+$/i.test(addressHex) || !/^[0-9A-F]{4}$/i.test(portHex)) {
                continue;
            }

            const port = Number.parseInt(portHex, 16);
            const address = ipv6
                ? addressHex === "0".repeat(32)
                    ? "*"
                    : ""
                : addressHex.length === 8
                  ? ipv4(addressHex)
                  : "";

            if (port < 1024 || (!ipv6 && address !== "0.0.0.0" && !knownHosts.has(address))) {
                continue;
            }

            if (address !== "") {
                add(port, address);
            }
        }
    }

    return result;
}

/** Whether an HTTP server answers on `host:port`, and its page title when it has one. */
function probeHttp(host: string, port: number): Promise<{ title: string } | undefined> {
    return new Promise((done) => {
        let finished = false;

        const finish = (answer: { title: string } | undefined) => {
            if (!finished) {
                finished = true;
                done(answer);
            }
        };

        const request = httpRequest(
            {
                host,
                port,
                path: "/",
                method: "GET",
                timeout: 600,
                headers: { accept: "text/html" },
            },
            (response) => {
                let body = "";

                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;

                    if (body.length > 65_536) {
                        response.destroy();
                    }
                });

                const finishResponse = () => {
                    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? "")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 80);

                    finish(HTTPS_ONLY_RESPONSE.test(title) ? undefined : { title });
                };

                response.on("end", finishResponse);
                response.on("close", finishResponse);
            },
        );

        request.on("timeout", () => request.destroy());
        request.on("error", () => finish(undefined));
        request.end();
    });
}

/** Tailscale Serve provides the HTTPS host names and local proxies that clients can open from a phone. */
async function tailscaleServices(
    local: readonly { port: number; url: string; title: string }[],
): Promise<ServedService[]> {
    let config: {
        TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean }>;
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };

    try {
        const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
            encoding: "utf8",
            timeout: 1500,
            maxBuffer: 1_000_000,
        });

        config = JSON.parse(stdout) as typeof config;
    } catch {
        return [];
    }

    const titles = new Map(local.map((service) => [service.port, service.title]));
    const found: ServedService[] = [];

    for (const [address, web] of Object.entries(config.Web ?? {})) {
        const split = address.lastIndexOf(":");

        if (split < 1) {
            continue;
        }

        const host = address.slice(0, split);
        const port = Number(address.slice(split + 1));
        const tcp = config.TCP?.[String(port)];
        const secure = tcp?.HTTPS === true;
        const scheme = secure ? "https" : tcp?.HTTP === true ? "http" : undefined;
        const route = web.Handlers?.["/"] ? "/" : Object.keys(web.Handlers ?? {}).sort()[0];
        const proxy = route === undefined ? undefined : web.Handlers?.[route]?.Proxy;

        if (
            !host.endsWith(".ts.net") ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535 ||
            scheme === undefined ||
            route === undefined ||
            !route.startsWith("/") ||
            proxy === undefined
        ) {
            continue;
        }

        let backendPort: number;

        try {
            const target = new URL(proxy);

            if (target.protocol !== "http:" && target.protocol !== "https:") {
                continue;
            }

            backendPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
        } catch {
            continue;
        }

        found.push({
            port,
            backendPort,
            title: titles.get(backendPort) || `Tailnet service`,
            link: {
                network: "tailnet",
                host,
                url: `${scheme}://${host}:${port}${route}`,
                secure,
            },
        });
    }

    return found;
}

/** Find Tailscale Serve links first, then other reachable local-network and tailnet HTTP pages. */
export async function networkServices(exclude: readonly number[] = [], options: Options = {}) {
    const hosts = options.hosts ?? linkHosts();
    const listeners = options.listeners ?? listeningOn(hosts);
    const local = (options.local ?? (await localServers(exclude))).filter(
        (service) => !HTTPS_ONLY_RESPONSE.test(service.title),
    );
    const served = options.served ?? (await tailscaleServices(local));
    const servedBackends = new Set(served.map((service) => service.backendPort));
    const servedPorts = new Set(served.map((service) => service.port));
    const probe = options.probe ?? probeHttp;
    const candidates = [...listeners]
        .filter(
            ([port, binds]) =>
                port >= 1024 &&
                !exclude.includes(port) &&
                hosts.some((host) => binds.has("*") || binds.has(host.host)),
        )
        .sort(([a], [b]) => a - b)
        .slice(0, MAX_PORTS);
    const found = await Promise.all(
        candidates.flatMap(([port]) =>
            hosts.map(async (host) => {
                const binds = listeners.get(port)!;

                if (!binds.has("*") && !binds.has(host.host)) {
                    return undefined;
                }

                const answer = await probe(host.host, port);

                return answer === undefined
                    ? undefined
                    : {
                          port,
                          title: answer.title || `Port ${port}`,
                          link: {
                              network: host.network,
                              host: host.host,
                              url: `http://${host.host}:${port}/`,
                          },
                      };
            }),
        ),
    );
    const services = new Map<number, NetworkService>();

    for (const service of served) {
        const existing = services.get(service.port) ?? {
            port: service.port,
            title: service.title,
            links: [],
        };

        if (existing.title === "Tailnet service" && service.title !== existing.title) {
            existing.title = service.title;
        }

        existing.links.push(service.link);
        services.set(service.port, existing);
    }

    for (const service of local) {
        if (servedBackends.has(service.port)) {
            continue;
        }

        services.set(service.port, {
            port: service.port,
            title: service.title || `Port ${service.port}`,
            links: [{ network: "server", host: "localhost", url: service.url }],
        });
    }

    for (const each of found) {
        if (each === undefined || (each.link.network === "tailnet" && servedPorts.has(each.port))) {
            continue;
        }

        const service = services.get(each.port) ?? {
            port: each.port,
            title: each.title,
            links: [],
        };

        if (service.title === `Port ${each.port}` && each.title !== `Port ${each.port}`) {
            service.title = each.title;
        }

        service.links.push(each.link);
        services.set(each.port, service);
    }

    for (const service of services.values()) {
        service.links.sort(
            (a, b) =>
                (a.secure ? 0 : a.network === "tailnet" ? 1 : a.network === "local" ? 2 : 3) -
                (b.secure ? 0 : b.network === "tailnet" ? 1 : b.network === "local" ? 2 : 3),
        );
    }

    const priority = (service: NetworkService) =>
        service.links.some((link) => link.network === "tailnet" && link.secure)
            ? 0
            : service.links.some((link) => link.network === "tailnet")
              ? 1
              : 2;

    return [...services.values()].sort((a, b) => priority(a) - priority(b) || a.port - b.port);
}
