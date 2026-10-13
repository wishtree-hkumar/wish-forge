---
name: php
description: PHP standards - types, errors, classes, data access and security, with a section for Laravel projects.
paths:
  - "**/*.php"
---
# PHP standards

## Language

- New PHP source files start with `declare(strict_types=1);`. Do not add it to an existing file or to a template without checking its callers: it changes how calls behave.
- Follow PSR-12 as the project's formatter applies it, and PSR-4 for where classes live.
- Declare a type for every parameter, return value and property. Use `?T` or a union when a value can be absent.
- Compare with `===` and `!==`. Never rely on loose comparison or type juggling.
- Use `readonly` properties and constructor promotion for value objects.
- Use an `enum` for a fixed set of values, not class constants or strings.
- Use `match` for a value-to-value mapping. It is strict and must be exhaustive.
- Do not use `@` to suppress errors, `extract`, `eval`, or variable variables.

## Structure

- One class per file. Make a class `final` unless it is designed to be extended.
- Inject what a class needs through its constructor. Do not call static helpers or a service locator from inside business logic.
- Keep controllers and command handlers thin: read input, call a service, return a response.
- Do not use static mutable state or global variables.
- Return typed objects or typed collections from services, not associative arrays whose keys the caller must guess.

## Errors

- Throw exceptions for failures. Do not return `false` or `null` to signal an error.
- Catch the specific exception type you can handle. Catch `Throwable` only at a top-level boundary that logs and reports.
- Define a domain exception class for a failure callers need to tell apart, and keep the original as `previous`.

## Data and security

- Use prepared statements with bound parameters for every query. Never interpolate a value into SQL.
- Escape output for the context it lands in. In templates, use the engine's escaping and never print raw input.
- Validate and cast request input at the boundary, into a typed object.
- Hash passwords with `password_hash` and check them with `password_verify`.
- Do not `unserialize` data from outside the program. Use JSON.
- Check the type, size and destination of an uploaded file, and store it outside the web root under a name you generate.

## Tests

- Write tests with the project's test framework, one behavior per test method, named for the behavior.
- Use data providers for the same check over several inputs.

## Laravel

These apply only when the project uses Laravel.

- Validate requests in a form request class, and use only the validated data.
- Never pass the whole request to `create` or `update`. Set `$fillable` and pass named fields.
- Put authorization in policies and call them from the controller or the form request.
- Prevent query-in-a-loop problems: eager-load relations with `with`, and enable lazy-loading prevention outside production.
- Keep business logic out of controllers, models' boot methods and templates. Put it in a service or an action class.
- Read configuration with `config()`. Call `env()` only inside files in the `config` directory.
- Wrap related writes in `DB::transaction`.
- Do slow work in queued jobs, and make each job safe to run twice.
- Return API responses through resource classes, not raw models.
- Change the schema only through migrations, and give each one a working `down`.
