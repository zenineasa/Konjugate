/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Decodes the one-shot report messages the engine's validate/infer/fit/inspect CLI subcommands
// write (see engine/src/*Report.cpp and protocol/engineProtocol.proto) -- the counterpart to
// engineProtocol.mjs, which hand-decodes the streaming control/event wire format instead. These
// reports go through the real protobufjs runtime rather than a hand-written decoder: unlike the
// small, fixed set of streaming messages, report shapes have real nesting (InferenceReport's
// edges -> terms[], an optional interaction sub-message) that's worth generating from
// protocol/engineProtocol.proto rather than hand-writing and hand-maintaining a decoder for.
//
// protobufjs represents uint64 fields as Long objects by default (a JS number can't exactly
// represent the full 64-bit range) -- every id in this codebase (parameterId, nodeId, ...) is a
// plain JS number already, well within the safe-integer range for any real project, so Long
// support is disabled here to get plain numbers back instead of {low, high, unsigned} objects.
// This must run before the generated module is first used, not just before it's imported: import
// evaluation order alone doesn't guarantee that, so the assignment and configure() call are this
// module's own top-level statements, guaranteed to run before any decode* function below is ever
// invoked by a caller.
import protobuf from 'protobufjs/minimal.js';
protobuf.util.Long = null;
protobuf.configure();

// eslint-disable-next-line import/first -- must follow the Long-disabling configuration above.
import { konjugate } from './generated/reportMessages.mjs';

const { ValidationReport, InspectionReport, InferenceReport, FittingReport } = konjugate.protocol;

// arrays: true keeps every repeated field as [] rather than absent when empty; defaults: true
// keeps every scalar field at its zero value rather than absent, and -- as importantly -- leaves
// an unset message-typed field (InferredEdgeReport.interaction) as null rather than synthesizing
// a zero-valued object for it, matching the existing `edge.interaction ? ... : ...` truthy checks
// throughout the renderer (verified directly against a real encode/decode round trip, not assumed).
const toObjectOptions = { defaults: true, arrays: true };

export function decodeValidationReport(buffer) {
    return ValidationReport.toObject(ValidationReport.decode(buffer), toObjectOptions);
}

export function decodeInspectionReport(buffer) {
    return InspectionReport.toObject(InspectionReport.decode(buffer), toObjectOptions);
}

export function decodeInferenceReport(buffer) {
    return InferenceReport.toObject(InferenceReport.decode(buffer), toObjectOptions);
}

export function decodeFittingReport(buffer) {
    return FittingReport.toObject(FittingReport.decode(buffer), toObjectOptions);
}
