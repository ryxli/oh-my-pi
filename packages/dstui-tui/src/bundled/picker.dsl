;; bundled :: picker
;;
;; Single-select list. Emits the selected index (number) on Enter,
;; cancels on Escape. `items` is the list of labels, `selected-index`
;; is the initial cursor position.
(defcomponent picker (title items selected-index)
  (state
    (idx (if selected-index selected-index 0))
    (n (len items)))
  (view
    (flex-col :gap 0
      (when title (text title :accent))
      (each it items
        (flex-row :gap 1
          (item :basis 2
            (text (if (= idx __index__) ">" " ")
                  :style (if (= idx __index__) :accent :muted)))
          (item :grow 1
            (text (str it)
                  :style (if (= idx __index__) :bold :muted)))))))
  (bind :up    (set! idx (max 0 (- idx 1))))
  (bind :down  (set! idx (min (max 0 (- n 1)) (+ idx 1))))
  (bind :enter (emit idx))
  (bind :escape (cancel)))
