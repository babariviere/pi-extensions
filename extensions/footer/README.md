# Footer

The TUI footer combines the project path, context-window gauge, selected model,
latest routed physical response, subscription usage, and extension statuses.
For virtual selections, when routing changes the answering model, it shows the selection and physical
model separately with their respective thinking levels. Before a response is
available it shows the selected model alone.
Ordinary physical selections retain their existing display and subscription provider
behavior, even before the newly selected model has answered.

Subscription data is supplied by the `usage` extension. The footer installs a
custom component only in Pi's TUI mode. Provider brand colors go through the
active Pi theme, so terminal color-depth conversion is respected.
