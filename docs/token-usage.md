# Token usage by agent and flow

wish-forge does not call a model, so the tokens a flow uses are billed by the developer's own harness. Usage has two parts:

1. **Fixed cost:** the agent and flow instructions wish-forge installs. It is the same on every run and is measured below with `wishforge tokens`.
2. **Task cost:** the code each agent reads and writes. It depends on the task and the size of the project, so it is shown only on the developer's machine, in their harness's usage view.

Figures are for Claude Code, estimated at about 4 characters per token.

## forge-quick

| Stage  | Agent               |     Tokens |
| ------ | ------------------- | ---------: |
| DEFINE | requirement-analyst |        439 |
| PLAN   | planner             |        423 |
| BUILD  | builder             |        481 |
| VERIFY | tester / fixer      |  496 / 447 |
| REVIEW | reviewer            |        567 |
| SHIP   | release-gate        |        707 |
|        | Flow instructions, when started | 1,948 |
|        | Agent list, every session       |   283 |
|        | **Total fixed cost, one pass**  | **~5,800** |

## forge-full

| Stage        | Agent               |     Tokens |
| ------------ | ------------------- | ---------: |
| REQUIREMENT  | requirement-analyst |        439 |
| ANALYZE      | analyzer            |        469 |
| PLAN         | planner             |        423 |
| ARCHITECT    | architect           |        481 |
| BUILD        | builder             |        481 |
| TEST ⇄ FIX   | tester / fixer      |  496 / 447 |
| REVIEW       | reviewer            |        567 |
| RELEASE_GATE | release-gate        |        707 |
| DEPLOY       | deployer            |        567 |
| FEEDBACK     | feedback            |        396 |
|              | Flow instructions, when started | 2,059 |
|              | Agent list, every session       |   452 |
|              | **Total fixed cost, one pass**  | **~7,980** |

## Optional reviewers at REVIEW

Each installed reviewer runs at REVIEW in either flow.

| Agent                          |    Tokens |
| ------------------------------ | --------: |
| security-reviewer              |       767 |
| performance-reviewer           |       741 |
| database-reviewer              |       795 |
| accessibility-reviewer         |       769 |
| standards-reviewer             |       712 |
| **All five, per review round** | **3,784** |

Each TEST ⇄ FIX loop or extra review round adds that agent's cost again.

## Tokens used to build wish-forge

Measured from the Claude Code session logs, 13–16 October 2026, model Claude Opus 5.5.

| Metric           |          Tokens |
| ---------------- | --------------: |
| Model calls      |             622 |
| Output           |       1,037,153 |
| Cache write      |       3,841,196 |
| Cache read       |     209,045,089 |
| Input (uncached) |           1,368 |
| **Total**        | **213,924,806** |

98% of the total is cache reads, which are billed at a small fraction of the normal input price.

## Measuring it yourself

Install a flow in a project and run:

```bash
wishforge tokens
```
