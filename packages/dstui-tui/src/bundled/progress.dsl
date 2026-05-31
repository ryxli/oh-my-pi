;; bundled :: progress
;;
;; Indeterminate spinner + caption. Settles only when the host cancels
;; via Escape (so the agent can use this for long-running background
;; work and read `:cancel` to mean "user wants to abort").
(defcomponent progress (caption tick-ms)
  (state
    (frame 0)
    (frames (list "⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")))
  (view
    (flex-row :gap 1
      (text (nth frames (mod frame (len frames))) :accent)
      (text (str (if caption caption "Working...")) :muted)))
  (every (if tick-ms tick-ms 100) (set! frame (+ frame 1)))
  (bind :escape (cancel)))
