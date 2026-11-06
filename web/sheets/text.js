// One text field and a button: renaming, resetting, instructions, compacting, and your name.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";

export function TextSheet({
    title,
    label,
    hint = "",
    initial = "",
    placeholder = "",
    submit,
    multiline = false,
    button = "Save",
    footer = null,
    extra = null,
}) {
    const [value, setValue] = useState(initial);
    const save = () =>
        attempt(async () => {
            await submit(value);
            closeSheet();
        });

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        ${hint && html`<p class="muted small">${hint}</p>`}
        <div class="field">
            <div class="label">${label}</div>
            ${
                multiline
                    ? html`<textarea
                        rows="4"
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                    ></textarea>`
                    : html`<input
                        autofocus
                        aria-label=${label}
                        value=${value}
                        placeholder=${placeholder}
                        onInput=${(event) => setValue(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && save()}
                    />`
            }
        </div>
        ${extra}
        <div class="sheet-actions">
            <button class="button" onClick=${closeSheet}>Cancel</button>
            <button class="button primary" onClick=${save}>${button}</button>
        </div>
        ${footer}
    <//>`;
}

const modelKey = (model) => `${model.provider}/${model.id}`;

function modelLabel(model, level) {
    return model
        ? `${model.name}${model.reasoning ? ` · ${level ?? "off"}` : ""}${model.signIn ? " (needs sign-in)" : ""}`
        : "Not available";
}

/** The compact sheet keeps its instructions and can choose a different summary model for this compaction. */
export function CompactSheet({ piaId }) {
    const { models, server } = store.state;
    const view = piaId === undefined ? store.state.view : store.state.piaView;
    const [selection, setSelection] = useState("");
    const [thinkingLevel, setThinkingLevel] = useState("high");
    const sessionModel = view.agent?.model;
    const sessionChoice = sessionModel
        ? models.find(
              (model) =>
                  model.provider === sessionModel.provider && model.id === sessionModel.modelId,
          )
        : undefined;
    const configured = server?.compactionModel ?? server?.defaultModel;
    const configuredModel = configured
        ? models.find(
              (model) => model.provider === configured.provider && model.id === configured.modelId,
          )
        : undefined;
    const picked = models.find((model) => modelKey(model) === selection);
    const levels = picked?.reasoning ? picked.levels : [];
    const choice =
        selection === "session" && sessionModel
            ? {
                  provider: sessionModel.provider,
                  modelId: sessionModel.modelId,
                  thinkingLevel: view.agent?.thinkingLevel ?? "off",
              }
            : picked
              ? { provider: picked.provider, modelId: picked.id, thinkingLevel }
              : undefined;

    const onModel = (event) => {
        const next = event.currentTarget.value;
        const model = models.find((each) => modelKey(each) === next);

        setSelection(next);

        if (model) {
            setThinkingLevel(
                model.reasoning && model.levels.includes("high")
                    ? "high"
                    : (view.agent?.thinkingLevel ?? "off"),
            );
        }
    };

    return html`<${TextSheet}
        title="Compact context"
        hint="A different model can review and write the summary. This does not change the session's model."
        label="What should the summary keep? (optional)"
        placeholder="e.g. the failing test names"
        multiline=${true}
        button="Compact"
        extra=${html`<div class="field">
            <label class="label" for="compact-model">Summary model</label>
            <select id="compact-model" value=${selection} onChange=${onModel}>
                <option value="">Use default · ${configured ? modelLabel(configuredModel, configured.thinkingLevel) : "session model"}</option>
                ${sessionModel && html`<option value="session">Session model · ${modelLabel(sessionChoice, view.agent?.thinkingLevel)}</option>`}
                ${models.map(
                    (model) => html`<option
                        value=${modelKey(model)}
                        disabled=${model.signIn}
                    >
                        ${model.name} · ${model.provider}/${model.id}${model.signIn ? " (needs sign-in)" : ""}
                    </option>`,
                )}
            </select>
        </div>
        ${
            picked?.reasoning &&
            html`<div class="field">
            <label class="label" for="compact-thinking">Thinking level</label>
            <select
                id="compact-thinking"
                value=${thinkingLevel}
                onChange=${(event) => setThinkingLevel(event.currentTarget.value)}
            >
                ${levels.map((level) => html`<option value=${level}>${level}</option>`)}
            </select>
        </div>`
        }`}
        submit=${(instructions) =>
            actions.compact(instructions || undefined, choice, piaId ?? undefined)}
    />`;
}
