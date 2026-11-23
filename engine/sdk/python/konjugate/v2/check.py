# Copyright © 2026 Zenin Easa Panthakkalakath

"""python -m konjugate.v2.check program.py [name=value ...] [--time T] [--json]

Runs the standard checks on a version 2 program (docs/programs.md, "Testing a program"), as Konjugate's Check program does: inputs and
constants by name (as in the code or as the file binds them), the time to check at, and --json for a machine-readable answer
({"ok", "program", "problems", "outputs", "memory"}). Exits 0 when every check passes, 1 when one does not, 2 when the program cannot be
loaded.
"""

import json
import sys

from konjugate.v2._host import load_program_class
from konjugate.v2.testing import Harness, check_program


def main(arguments):
    if not arguments:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    path = arguments[0]
    values = {}
    time = 0.0
    as_json = False
    rest = arguments[1:]
    index = 0
    while index < len(rest):
        argument = rest[index]
        if argument == "--json":
            as_json = True
        elif argument == "--time" and index + 1 < len(rest):
            time = float(rest[index + 1])
            index += 1
        elif "=" in argument:
            name, value = argument.split("=", 1)
            values[name.strip()] = float(value)
        index += 1
    try:
        program_class = load_program_class(path)
    except Exception as error:  # noqa: BLE001 -- said plainly, with the line where Python gives one
        line = getattr(error, "lineno", None)
        message = f"{error}" + (f" (line {line})" if line and "Line" not in str(error) else "")
        if as_json:
            print(json.dumps({"ok": False, "program": None, "problems": [message], "loadFailed": True}))
        else:
            print(f"The program could not be loaded: {message}")
        return 2
    problems = check_program(program_class, values, t=time)
    outputs, memory = {}, {}
    if not problems:
        try:
            harness = Harness(program_class)
            outputs = harness.evaluate(time, **values)
            memory = harness.memory
        except Exception as error:  # noqa: BLE001
            problems.append(str(error))
    if as_json:
        print(json.dumps({"ok": not problems, "program": program_class.__name__, "problems": problems, "outputs": outputs, "memory": memory}))
    elif problems:
        print(f"{program_class.__name__}: {len(problems)} problem{'s' if len(problems) != 1 else ''}")
        for problem in problems:
            print(f"- {problem}")
    else:
        print(f"{program_class.__name__}: every check passed.")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
