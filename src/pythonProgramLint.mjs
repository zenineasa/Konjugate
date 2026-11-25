/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's check of a Python program as you type (docs/proposals/codeEditor.md, "Checks that know the SDK"), the same on the
// desktop (a Python process) and in the web edition (Pyodide). It never imports or runs the program: ast.parse, then, once the source
// parses, every check below together, and compile()'s own warnings.
//
//   - a read of a port or memory value the program does not declare (x.measurment), with what it does declare: an error, as the run
//     would fail there;
//   - a declared input, parameter or constant the program never reads: a hint, never an error;
//   - Python's own warnings (SyntaxWarning: "is" with a literal, an invalid escape) at their lines.
//
// Only a class that derives from Node or Relationship directly is read (one built on a class of its own may declare ports there). An
// `x` used other than by attribute or subscript (passed to a function, getattr(x, name)) makes the never-read hint stay quiet.
//
// _konjugate_lint(source) answers { valid, diagnostics: [{ line, column, endColumn?, severity: 'error' | 'warning' | 'info', message }] },
// endColumn (exclusive) where it marks only part of the line (the name of an input never read, the read of a port not declared).

export const pythonProgramLintFunction = String.raw`
def _konjugate_lint(source):
    import ast, warnings

    def camel(name):
        head, *rest = name.split("_")
        return head + "".join(part[:1].upper() + part[1:] for part in rest if part)

    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return {"valid": False, "diagnostics": [{"line": error.lineno or 1, "column": error.offset or 1, "severity": "error", "message": error.msg}]}

    diagnostics = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            compile(source, "<program>", "exec")
        except SyntaxError as error:
            diagnostics.append({"line": error.lineno or 1, "column": error.offset or 1, "severity": "error", "message": error.msg})
        for warning in caught:
            diagnostics.append({"line": getattr(warning, "lineno", 1) or 1, "column": 1, "severity": "warning", "message": str(warning.message)})

    port_types = {"Input": "input", "Parameter": "parameter", "Constant": "constant", "Output": "output"}
    memory_types = {"Memory", "Random"}

    def base_name(node):
        return node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else None

    def call_name(node):
        return base_name(node.func) if isinstance(node, ast.Call) else None

    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or not any(base_name(base) in ("Node", "Relationship") for base in cls.bases):
            continue
        inputs = {}
        outputs = set()
        memory = set()
        for statement in cls.body:
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
                continue
            attribute = statement.targets[0].id
            kind = call_name(statement.value)
            if kind in port_types:
                key = camel(attribute)
                for keyword in statement.value.keywords:
                    if keyword.arg == "name" and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
                        key = keyword.value.value
                if kind == "Output":
                    outputs.add(attribute)
                else:
                    inputs[attribute] = {"key": key, "kind": port_types[kind], "line": statement.lineno, "column": statement.col_offset + 1,
                                         "endColumn": statement.col_offset + 1 + len(attribute), "read": False}
            elif kind in memory_types:
                memory.add(attribute)
        # A port named in the class itself (clock = Clock(sample_period)) is read there.
        for statement in cls.body:
            if isinstance(statement, ast.FunctionDef):
                continue
            for node in ast.walk(statement):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in inputs:
                    inputs[node.id]["read"] = True
        readable = {}
        for attribute, port in inputs.items():
            readable[attribute] = attribute
            readable[port["key"]] = attribute
        for name in memory:
            readable[name] = None
            readable[camel(name)] = None
        declared = ", ".join(sorted(set(list(inputs) + sorted(memory)))) or "none"
        dynamic = False

        for method in cls.body:
            if not isinstance(method, ast.FunctionDef):
                continue
            names = [argument.arg for argument in method.args.args]
            readers = set()
            if method.name in ("evaluate", "advance", "jacobian") and len(names) >= 3:
                readers.add(names[2])
            if method.name == "initialize" and len(names) >= 2:
                readers.add(names[1])
            if not readers:
                continue
            used = set()
            for node in ast.walk(method):
                key = None
                target = None
                if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in readers:
                    key, target = node.attr, node
                elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in readers:
                    index = node.slice
                    if isinstance(index, ast.Constant) and isinstance(index.value, str):
                        key, target = index.value, node
                    else:
                        dynamic = True
                if target is not None:
                    used.add(id(target.value))
                    if key in readable:
                        if readable[key] is not None:
                            inputs[readable[key]]["read"] = True
                    else:
                        diagnostics.append({"line": target.lineno, "column": target.col_offset + 1,
                                            "endColumn": (target.end_col_offset + 1) if getattr(target, "end_lineno", None) == target.lineno else None,
                                            "severity": "error", "message": f"'{key}' is not a port of this program: {declared}"})
            for node in ast.walk(method):
                if isinstance(node, ast.Name) and node.id in readers and isinstance(node.ctx, ast.Load) and id(node) not in used:
                    dynamic = True
        if not dynamic:
            for attribute, port in inputs.items():
                if not port["read"]:
                    word = {"input": "Input", "parameter": "Parameter", "constant": "Constant"}[port["kind"]]
                    diagnostics.append({"line": port["line"], "column": port["column"], "endColumn": port["endColumn"], "severity": "info",
                                        "message": f"{word} '{port['key']}' is never read."})

    diagnostics.sort(key=lambda diagnostic: (diagnostic["line"], diagnostic["column"]))
    return {"valid": not any(diagnostic["severity"] == "error" for diagnostic in diagnostics), "diagnostics": diagnostics}
`;

// The desktop's script: the source on standard input, the answer as JSON on standard output.
export const pythonProgramLintScript = `${pythonProgramLintFunction}
import json, sys
print(json.dumps(_konjugate_lint(sys.stdin.read())))
`;
