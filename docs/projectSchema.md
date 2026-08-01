<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Project document schema, version 1

The decoded `.kjt` payload is UTF-8 JSON with these top-level fields:

- `format`: literal `konjugate`
- `version`: integer `1`
- `copyright`: optional attribution string
- `metadata.units`: unit-system identifier
- `nodes`: array of node records
- `edges`: array of relationship records

Every persistent entity uses a globally unique UUID. User-facing names are mutable and must never be references.

A node contains `id`, `name`, optional `type`, three-number `position`, `states`, `sourceTerms`, and `appearance`. State symbols are unique lower-camel-case identifiers within their node. Source terms identify their updated state by symbol in version 1.

An edge contains `id`, `name`, source and target node/state references, directionality, LaTeX equation, optional normalized `equationModel`, parameters, and appearance. Parameter symbols are unique lower-camel-case identifiers within their edge. Normalized equation bindings and outputs use UUID references.

Unknown fields must be preserved when possible. Readers reject unsupported major schema versions. Additive fields may be introduced within a schema version when older readers can safely ignore them.
