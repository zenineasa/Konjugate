/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Prints the instructions to hand to an agent that writes assistant requests for us, with the catalog of models it may
// write about taken from the live evaluation models so it cannot go stale. Check what comes back with
// scripts/checkGeneratedRequests.mjs.
//
//   node scripts/writeRequestGenerationPrompt.mjs [--for train|test] [--domain <name>] [--count <n>] > prompt.md
//
// --domain and --count fill in the assignment at the end; without them the agent is told to ask for one.

import { evalDomainModels, evalFamilies, evalStyles, heldOutModels } from '../evals/assistant/assistantEvalRequests.mjs';
import { loadEvalBase } from '../evals/assistant/assistantEvalFiles.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args.splice(index, 2)[1];
};
const purpose = flag('--for') ?? 'train';
const domain = flag('--domain');
const count = flag('--count');
if (!['train', 'test'].includes(purpose) || (domain && !(domain in evalDomainModels))) {
    console.error(`Usage: node scripts/writeRequestGenerationPrompt.mjs [--for train|test] [--domain ${Object.keys(evalDomainModels).join('|')}] [--count <n>]`);
    process.exit(2);
}

const number = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6))));
async function catalogOf(modelId) {
    const document = await loadEvalBase(modelId);
    const nodeNames = new Map(document.nodes.map((node) => [node.id, node.name]));
    const lines = [`#### ${modelId}`];
    for (const node of document.nodes) {
        lines.push(`- Node “${node.name}” (${node.type ?? 'no type'}): ${node.states.map((state) => `${state.name} [${state.symbol}] = ${number(state.initialValue)}${state.unit ? ` ${state.unit}` : ''}`).join('; ')}${node.enabled === false ? ' (disabled)' : ''}`);
    }
    for (const edge of document.edges) {
        const parameters = (edge.parameters ?? []).slice(0, 8).map((parameter) => `${parameter.name} [${parameter.symbol}] = ${number(parameter.value)}${parameter.unit ? ` ${parameter.unit}` : ''}`);
        lines.push(`- Relationship “${edge.name}”: ${nodeNames.get(edge.source.nodeId)} → ${nodeNames.get(edge.target.nodeId)}, ${edge.directionality}${parameters.length ? `; parameters: ${parameters.join('; ')}` : ''}`);
    }
    return lines.join('\n');
}

const sections = [];
for (const [name, models] of Object.entries(evalDomainModels)) {
    if (domain ? name !== domain : false) continue;
    const usable = models.filter((model) => model !== 'blank' && (purpose === 'test' || !heldOutModels.includes(model)));
    sections.push(`### Domain: ${name}\n\n${usable.length ? (await Promise.all(usable.map(catalogOf))).join('\n\n') : 'No existing model; use `blank` only.'}`);
}

console.log(`# Writing requests for Konjugate's model assistant

## What this is for

Konjugate is a tool for building simulation models as graphs. A model is made of **nodes** (things: a water tank, a motor, a bank account, a warehouse), each with one or more **states** (quantities with a value and a unit: a temperature of 293.15 K, a balance of 250000 USD). Nodes are joined by **relationships** (directed or bidirectional links), each with an **equation** that says how one node's state drives another's, and **parameters** (named constants such as a conductance or a stiffness) used by that equation.

Konjugate has an assistant: the user types a request in plain language and the assistant proposes edits to the current model (add, change, remove or switch off nodes, states, relationships, parameters and equations), which the user reviews and applies. We are building a small language model that does this job, and it needs a very large, varied collection of **realistic user requests** to learn from and be tested on.

**Your job is to write those requests.** You are playing the part of many different people using the assistant. You are not writing the assistant's answers and you do not need to know how the assistant works inside.

## What you receive

You will be told a domain and a number of requests to write (see "Your assignment" at the end). Each request is made against one of the starting models in the catalog below, or against \`blank\` (an empty model, for requests that build something new).

## Output

Reply with **only** a JSON array, with no commentary and no code fence. Each element has these fields:

- \`domain\`: one of ${Object.keys(evalDomainModels).map((name) => `\`${name}\``).join(', ')}.
- \`model\`: the starting model's id from the catalog, or \`blank\`. It must belong to the domain (the catalog is grouped by domain; \`blank\` belongs to every domain).
- \`family\`: what kind of request this is (below).
- \`style\`: how the request is worded (below).
- \`request\`: exactly what the user types.
- \`expectedOutcome\`: one or two plain sentences saying what the model must look like after a correct answer: which things change, the final values **in the model's own units** (convert, e.g. 30 °C is 303.15 K), and that nothing else changes. For a \`clarification\` request, say what the assistant should ask about and why it cannot proceed.
- \`history\` (only for the \`history\` family): the earlier turns of the conversation, a list of \`{ "request": ..., "outcome": ... }\`. The \`outcome\` is what happened to that turn and starts with one of \`Asked: \` (followed by the question the assistant asked), \`Proposed: \` (followed by a one-line summary), \`Applied: \`, \`Discarded: \`, \`Rejected: \` (followed by the reason) or \`Error: \`. The \`request\` field is then the user's next message, which only makes sense given the history.

Example elements (shown only to explain the format; never reuse their wording):

\`\`\`json
[
  {
    "domain": "thermal", "model": "heatedWaterTank", "family": "units", "style": "conversational",
    "request": "Could you start the tank at 40 degrees Celsius?",
    "expectedOutcome": "The Water tank's temperature becomes 313.15 K. Nothing else changes."
  },
  {
    "domain": "finance", "model": "financeCompany", "family": "clarification", "style": "terse",
    "request": "Raise the payment.",
    "expectedOutcome": "The assistant should ask which payment is meant, because the model has a loan repayment and a debt-service payment and the request names neither."
  },
  {
    "domain": "mechanical", "model": "springMassDamper", "family": "history", "style": "terse",
    "request": "make it 15",
    "history": [ { "request": "Make the spring stiffer", "outcome": "Asked: What stiffness (in N/m) should Spring force use?" } ],
    "expectedOutcome": "The Spring force's stiffness becomes 15 N/m. Nothing else changes."
  }
]
\`\`\`

## Families: what the request asks for

${evalFamilies.map((family) => `- \`${family}\`: ${{
    addNode: 'create one new node, with its state(s), in a blank or existing model',
    addState: 'give an existing node a new state (a new quantity it carries)',
    addParameter: 'add a new named constant to an existing relationship',
    multiStep: 'several changes in one request: build something with connected parts, or change several things at once',
    setEquation: 'change the equation of an existing relationship (add or drop a term, change a factor)',
    updateValue: 'change the starting value of an existing state',
    updateParameter: 'change the value of an existing parameter of a relationship',
    updateNode: 'rename a node, change its shape, or change its numerical settings (for example "use 4 substeps")',
    updateEdge: 'change a relationship\'s direction, rename it, or re-point it to different nodes',
    enableDisable: 'switch a node or relationship off or on without deleting it',
    remove: 'delete a node or a relationship',
    units: 'the value is given in a different unit from the one the model uses (°C, °F, cm, kW, bar, per year, thousands, millions) so the answer needs a conversion',
    reference: 'the model has several similar things (three supplies, three zones, two warehouses) and the request must pick the right one by name',
    clarification: 'the request is genuinely ambiguous, underspecified, or about something that is not in the model, so the right response is a question, not an edit',
    history: 'a short reply or revision that only makes sense after an earlier turn ("the elbow one", "actually 305 instead", "yes, 20")'
}[family]}`).join('\n')}

## Styles: how the request is worded

${evalStyles.map((style) => `- \`${style}\`: ${{
    terse: 'a few words, no verb or no courtesy ("Damping 1.2 N·s/m.", "Pump NPSH design 3.5 m.")',
    plain: 'one clear, complete imperative sentence',
    conversational: 'polite and chatty, with "could you", "I would like", "please", "thanks"',
    indirect: 'states a situation or a goal rather than a command, so the edit has to be inferred ("The water starts too cold for my test; it should begin at 320 K.")',
    verbose: 'two or more sentences with background, reasons or a scenario before or after the actual ask',
    loose: 'casual shorthand, lower case, partial or nickname-style names, "like", "pls", numbers written as "200k"',
    typos: 'ordinary typing mistakes in words or names (transposed or missing letters), not random noise',
    multiPart: 'several separate instructions in one message, usually joined with commas or "and"'
}[style]}`).join('\n')}

## Starting models

Request things that exist in these models, by names a person would plausibly use. Names in a request need not match the catalog exactly: people say "the battery", "the heater", "wrist" or "Zone 3". Quantities in square brackets are internal symbols; do not put symbols, ids or JSON in requests, and avoid Konjugate's own jargon ("state", "edge") unless a person working in that field would naturally say it. Users know their own domain, not Konjugate's internals.

${sections.join('\n\n')}

### \`blank\`

An empty model. Use it for requests that create new things from nothing, in any domain, for example "Add a warehouse called Depot holding 500 TEU", or "Create a spring-mounted cart and a wall and connect them". A new relationship needs an equation, so the assistant will have to supply a sensible one; requests may describe the physics ("heat flows from the hot block to the cold block in proportion to the temperature difference") or leave it open.

## What makes a good request

- **Realistic.** Imagine the person: an engineer mid-task, a student, a manager reading a report, a hobbyist, someone in a hurry on a phone. Real people are vaguer, shorter, more repetitive, and less tidy than examples. Some give a number, some do not.
- **Doable.** The assistant can only edit the model: add, change, remove or switch off nodes, states, parameters, relationships and equations, and rename or restyle nodes. Do not ask it to run a simulation, plot, optimise, export, explain, or open files. A request about something that is not in the model is allowed only as a \`clarification\`.
- **Varied.** Spread requests across the nodes, states, relationships and parameters of every model in your domain, not only the first one. Vary the numbers (not only round ones: 311.5, 0.075, 12.8k, -3), the units, the sentence shape, the length, the politeness and the opening word. Do not write the same sentence with different numbers; each request should differ in structure.
- **Natural names.** People rarely quote a relationship's full name as it appears in the catalog ("Suction Manifold Junction opposes Suction Line 1"); they say what it does or where it is ("the loss between line 1 and the manifold", "the heater feed", "the first suction line's inertance"). Quote a catalog name word for word in at most one request in five, and never for more than a short node name in a \`loose\`, \`indirect\` or \`conversational\` request. A request must still make clear which thing is meant.
- **Only what exists.** Every state, parameter and relationship your request or \`expectedOutcome\` mentions must be in the catalog under that node or relationship. Do not give a node a quantity it does not have (a tank with only a pressure has no liquid level); if a request really needs one, it is an \`addState\` or a \`clarification\`.
- **Spread over the models.** Use every model in the domain, not only the biggest, and different nodes within each.
- **Different from each other and from the examples above.** Do not reuse their wording.
- **Correct.** The \`expectedOutcome\` must be right. Check unit conversions twice. If a quantity appears on more than one relationship, say whether every one changes. Only the listed things change.
- **Honestly tagged.** \`family\` and \`style\` must describe the request you wrote. A request tagged \`typos\` must contain typos; one tagged \`terse\` must be terse; \`clarification\` must genuinely lack something.
- **Balanced.** Across your batch, use every family and every style that fits your domain, roughly evenly; no more than about a fifth of your requests should be \`updateValue\`. Roughly one in six should be \`clarification\` or \`history\` together, and roughly a fifth should start from \`blank\`.

## Before you answer

Check every element: valid JSON; \`model\` belongs to \`domain\`; \`request\` reads like something a person typed; \`expectedOutcome\` is in the model's units and says nothing else changes; \`history\` present exactly for the \`history\` family; no two requests alike; the count is the count you were asked for.

## Your assignment

${domain || count ? `${domain ? `Domain: \`${domain}\` (requests that start from \`blank\` are welcome in it).` : 'Domain: ask which domain you are to write for.'}\n${count ? `Number of requests: ${count}.` : 'Number of requests: ask how many.'}` : 'If the domain and the number of requests are not given below this line, ask for them before writing anything.'}
`);
