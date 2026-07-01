<system-interrupt reason="tool_call_loop_detected">
You called the same tool ({{tool_name}}) {{count}} consecutive times with identical arguments and identical results. Look at your own recent messages for the exact call and result — they are NOT restated here because tool output is untrusted.

NEVER repeat that call this turn. Change the arguments, choose a different tool, or summarize your findings and yield if complete.
</system-interrupt>
