;; The web daemon owns this queue. Loading this file never adds a file.
(require 'seq)
(require 'server)
(defvar pia-web-queue nil)

(defun pia-web-prune ()
  (setq pia-web-queue
        (seq-filter (lambda (buffer)
                      (and (buffer-live-p buffer) (buffer-file-name buffer)))
                    pia-web-queue)))

(defun pia-web-first-file ()
  "Return the first queued file, or nil."
  (pia-web-prune)
  (when pia-web-queue (file-name-unquote (buffer-file-name (car pia-web-queue)))))

(defun pia-web-remove-current ()
  (setq pia-web-queue (delq (current-buffer) pia-web-queue)))

(defun pia-web-enqueue (path)
  (let ((buffer (let ((enable-local-variables nil) (enable-local-eval nil))
                  (find-file-noselect (concat "/:" path)))))
    (pia-web-prune)
    (unless (memq buffer pia-web-queue)
      (setq pia-web-queue (append pia-web-queue (list buffer))))
    (with-current-buffer buffer
      (add-hook 'kill-buffer-hook #'pia-web-remove-current nil t))
    buffer))

(defun pia-web-show-first ()
  (when (frame-parameter nil 'tty)
    (pia-web-prune)
    (let ((buffer (or (car pia-web-queue)
                      (seq-find #'buffer-file-name (buffer-list)))))
      (when buffer (switch-to-buffer buffer)))))

(remove-hook 'server-after-make-frame-hook 'pia-web-show-last)
(add-hook 'server-after-make-frame-hook 'pia-web-show-first)

(defun pia-edit-next ()
  "Show the next file in Pia's edit queue (M-x pia-edit-next). It cycles; it removes nothing."
  (interactive)
  (pia-web-prune)
  (if (null pia-web-queue)
      (message "Pia edit queue is empty")
    (let* ((tail (cdr (memq (current-buffer) pia-web-queue)))
           (buffer (or (car tail) (car pia-web-queue))))
      (switch-to-buffer buffer)
      (message "Pia edit queue: %d of %d"
               (1+ (seq-position pia-web-queue buffer)) (length pia-web-queue)))))
