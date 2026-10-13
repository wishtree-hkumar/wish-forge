---
name: python
description: Python standards - typing, functions, errors, data, packaging and pytest.
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python standards

## Style

- Follow PEP 8 as the project's formatter applies it. Do not hand-format around the tool.
- Use `snake_case` for functions and variables, `PascalCase` for classes, and `UPPER_CASE` for constants.
- Prefer f-strings for building text, except in logging calls, where you pass arguments so formatting is deferred.
- Use `pathlib.Path` for file paths, not string joining.
- Compare with `is` only for `None`, `True` and `False`. Use `==` for values.

## Typing

- Annotate every function's parameters and return type, including `-> None`.
- Use built-in generics (`list[str]`, `dict[str, int]`) and `X | None`, not the older `typing` aliases.
- Do not use `Any` to make the type checker quiet. Narrow with `isinstance`, or define a `Protocol`.
- Describe structured data with a `dataclass` or a typed model, not a bare `dict` or tuple.
- Keep the type checker clean. An ignore comment names the error code and says why.

## Functions and data

- Never use a mutable default argument. Default to `None` and create the value inside.
- Make arguments keyword-only once a function takes more than three, or when a boolean is passed.
- Return one type from a function. Do not return a value on one path and `None` on another without saying so in the type.
- Prefer a comprehension to a loop that appends, and a generator when the result is only iterated once.
- Mark data that should not change as frozen.
- Do not use module-level mutable state. Pass dependencies in.

## Errors

- Catch the narrowest exception that you can handle. Never a bare `except:`, and `except Exception` only at a top-level boundary that logs and re-raises or reports.
- Chain with `raise NewError(...) from err` so the cause is kept.
- Define a specific exception class for a failure callers need to tell apart.
- Use a `with` block for anything that must be closed or released.
- Do not use `assert` for checks that must run in production. Assertions can be switched off.

## Modules and packaging

- Use absolute imports. No wildcard imports.
- Importing a module has no side effects: no network, no file writes, no work at import time. Put a script's entry behind `if __name__ == "__main__":`.
- Declare dependencies in `pyproject.toml` and commit the lockfile the project uses.
- Do not read environment variables all over the code. Load settings once, validate them, and pass them on.

## Async

- Do not call blocking code from a coroutine. Use the async client, or hand the call to a worker thread.
- Every task you create is awaited or kept and cancelled. Do not drop the reference.

## Tests

- Write tests with pytest: plain functions, plain `assert`, one behavior per test.
- Share setup through fixtures, and keep each fixture small. Prefer `tmp_path` and `monkeypatch` to hand-rolled patching.
- Use `pytest.mark.parametrize` for the same check over several inputs.
- Assert on an exception with `pytest.raises` and check its message or type, not just that something was raised.
