;; bundled :: confirm
;;
;; Two-option confirmation. Emits `true` on Enter when "Yes" is
;; highlighted, `false` otherwise. Cancels on Escape.
(defcomponent confirm (prompt yes-label no-label default-yes)
  (state
    (yes (if (= default-yes false) false true)))
  (view
    (flex-col :gap 0
      (text (str prompt) :accent)
      (flex-row :gap 2
        (text (str (if yes ">" " ") " " (str (if yes-label yes-label "Yes")))
              :style (if yes :bold :muted))
        (text (str (if yes " " ">") " " (str (if no-label no-label "No")))
              :style (if yes :muted :bold)))))
  (bind :left  (set! yes true))
  (bind :right (set! yes false))
  (bind :tab   (set! yes (if yes false true)))
  (bind :enter (emit yes))
  (bind :escape (cancel)))
