/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Makes src/reportProtocol.mjs's `import protobuf from 'protobufjs/minimal.js'` (and
// src/generated/reportMessages.mjs's identical import) resolve in a browser: the web shell's
// index.html importmap points that bare specifier at this file instead of the real npm package,
// which is CommonJS and can't be loaded as an ES module directly (confirmed by testing this
// exact failure in a real renderer -- see docs/proposals/webEdition.md, phase 2's status notes).
// node_modules/protobufjs ships a pre-bundled browser build of exactly this "minimal" runtime
// (Reader/Writer/util/roots/rpc) as a classic global-exposing script -- loaded before this module
// via a plain <script> tag in index.html, the same pattern already used for occt-import-js and
// plotly.js.
export default window.protobuf;
