# Punch — AI Security Investigation & Remediation System

## 1. Product Positioning

Punch should **NOT** be built as another dependency vulnerability scanner.

GitHub/Dependabot and other tools already identify vulnerable dependencies.

Instead, Punch is an **AI-powered security investigation system** that answers:

> **“Does this vulnerability actually matter to this repository, can we prove it, what will break if we fix it, and can we safely validate the fix?”**

Dependency vulnerability detection is only one input into the system.

### Core pipeline

```text
GitHub Repository
        ↓
Orchestrator
        ↓
Planner
        ↓
┌───────────────────────────────────┐
│ Inventory Agent                   │
│ Vulnerability Research Agent      │
│ Reachability Agent                │
│ Upgrade Impact Agent              │
└───────────────────────────────────┘
        ↓
Security Investigator
        ↓
Adversarial Critic
        ↓
Candidate Remediation
        ↓
Isolated Validation Sandbox
        ↓
Human Approval
        ↓
GitHub Issue / PR
```

---

# 2. Core Differentiators

## A. Reachability / Exploitability Analysis — MUST HAVE

Do not stop at:

> `lodash X.Y.Z has CVE-XXXX`

Punch must investigate whether the vulnerable functionality is actually relevant to the repository.

The Reachability Agent should inspect:

* dependency graph
* imports
* source-code usage
* affected functions/APIs
* call sites
* routes/endpoints
* configuration
* application entry points
* tests
* whether affected functionality is externally reachable

Example:

```text
CVE severity: HIGH

Dependency:
foo 2.1.4

Affected function:
foo.parse()

Repository analysis:
✓ foo is installed
✓ foo.parse() exists
✗ foo.parse() is never imported
✗ affected functionality is not reachable

Conclusion:
Vulnerability exists in dependency,
but no evidence of affected code being reachable
in this repository.
```

The system must clearly distinguish:

```text
Vulnerability exists
        ≠
Application is exposed
        ≠
Vulnerability is exploitable in this repository
```

---

# 3. Upgrade Impact Analysis — MUST HAVE

Punch should answer:

> “If I upgrade this dependency, what could break?”

The Upgrade Impact Agent should inspect:

* current version
* patched version
* semantic-version change
* release notes
* changelog
* deprecated APIs
* removed APIs
* repository usage
* lockfile changes
* dependency tree
* tests
* CI configuration

Example output:

```text
UPGRADE ANALYSIS

foo:
2.1.4 → 2.4.0

Security:
HIGH

Upgrade impact:
LOW

Evidence:
✓ No removed API currently used
✓ No affected API usage detected
✓ Existing tests cover related module
✓ Patch version is available

Recommendation:
Upgrade to 2.4.0

Evidence-backed reasoning:
...
```

Do NOT invent numerical probabilities such as “87% safe” unless there is an actual methodology behind the number.

Prefer:

* LOW / MEDIUM / HIGH
* evidence
* detected risks
* unknowns
* validation results

---

# 4. Fix Simulation / Validation Sandbox — SIGNATURE FEATURE

This should make Punch substantially more differentiated.

Instead of only predicting whether an upgrade will work:

> **Actually test the proposed upgrade in an isolated environment.**

Flow:

```text
Candidate Fix
     ↓
Create temporary branch / workspace
     ↓
Apply dependency upgrade
     ↓
Install dependencies
     ↓
Run tests
     ↓
Run build
     ↓
Inspect diff
     ↓
Compare failures
     ↓
Generate validation report
```

Example:

```text
FIX VALIDATION

foo:
2.1.4 → 2.4.0

Installation: PASS
Build: PASS
Tests: 187/187 PASS
Relevant module tests: PASS
API compatibility: PASS

Result:
Upgrade validated successfully.
```

If tests fail:

```text
Upgrade validation FAILED

Tests:
181/187 PASS

6 failures detected.

Likely cause:
API behavior changed in foo 2.4.0.

Action:
DO NOT recommend automatic remediation.

Human review required.
```

This turns Punch from an **AI opinion engine** into an **evidence-producing security system**.

---

# 5. Adversarial Critic — MUST HAVE

The Critic should not merely check formatting.

Its job is:

> **Try to prove the investigation wrong.**

For every finding, ask:

1. Does the vulnerability actually apply?
2. Is the vulnerable package actually present?
3. Is the affected functionality used?
4. Is the affected code reachable?
5. Is the patched version real?
6. Is the proposed upgrade compatible?
7. Did another source contradict the finding?
8. Is the evidence current?
9. Is there a safer mitigation?
10. Did the investigator make an unsupported assumption?

The Critic can reject the result:

```text
INVESTIGATION REJECTED

Reason:
Reachability claim was unsupported.

Missing evidence:
No call-site analysis was performed.

Action:
Planner → create Reachability task
```

Then the system replans.

```text
Critic
  ↓
REJECT
  ↓
Planner
  ↓
New investigation
  ↓
Critic
  ↓
ACCEPT
```

---

# 6. Takeover / Agent Recovery — CORE SYSTEM FEATURE

Punch should retain the existing takeover architecture.

Every agent is a replaceable slot.

Example:

```text
REACHABILITY AGENT
        ↓
      CRASH
        ↓
   ┌───────────┐
   │ TAKEOVER  │
   └───────────┘
        ↓
Backup Agent
        ↓
Continue same task
```

The backup agent should receive:

* original task
* planner context
* previous agent output
* fetched evidence
* tool results
* files already inspected
* current state
* failure reason

It should NOT restart the entire investigation.

### Supported failure modes

Test the system against:

* agent crash
* timeout
* malformed output
* hallucinated claim
* tool failure
* rate limit
* critic rejection
* user manually killing an agent

The UI should visibly show:

```text
🔴 Reachability Agent failed

Reason:
Timeout after 30s

🟡 TAKEOVER

Backup Agent:
Gemini

Recovered context:
14 files
3 API responses
2 evidence records

Recovery:
2.8s
```

---

# 7. Evidence Ledger

Every important conclusion should have evidence attached.

Example:

```text
CLAIM:
foo.parse() is not used by the application.

EVIDENCE:
✓ src/api/parser.ts
✓ src/services/input.ts
✓ dependency graph
✓ static search

AGENT:
Reachability Agent

VERIFIED BY:
Critic

STATUS:
Verified
```

The final report should make it possible for a human to understand:

```text
Who made the claim?
What evidence did they use?
Which tools were called?
Who verified it?
Why was the conclusion accepted?
```

This directly supports the hackathon's human-auditable trace requirement.

---

# 8. Security Investigation Report

The final result should not simply be:

```text
12 vulnerabilities found.
```

Instead:

```text
PUNCH SECURITY INVESTIGATION

Repository:
example/repo

Dependencies analyzed:
143

Known vulnerabilities:
12

Investigated:
12

Relevant/reachable:
5

Validated as actionable:
3

Requires human review:
2

--------------------------------

Finding #1

Dependency:
foo 2.1.4

Vulnerability:
CVE-XXXX

Severity:
HIGH

Reachability:
REACHABLE

Evidence:
...

Upgrade:
2.1.4 → 2.4.0

Upgrade impact:
LOW

Sandbox validation:
PASS

Critic:
ACCEPTED

Recommended action:
Upgrade to 2.4.0

[Create GitHub Issue]
[Create Fix PR]
```

---

# 9. Human Approval

Punch must NEVER silently perform irreversible actions.

Before:

* creating GitHub issues
* opening PRs
* modifying repository files
* applying remediation

show:

```text
PROPOSED ACTION

Upgrade:
foo 2.1.4 → 2.4.0

Validation:
PASS

Tests:
187/187

Risk:
LOW

Evidence:
...

[ APPROVE ]   [ REJECT ]
```

Only after approval should the Executor act.

---

# 10. Supply-Chain Anomaly Detection — STRETCH FEATURE

If time allows, add a second security dimension beyond CVEs.

Punch can look for suspicious package/release signals such as:

* unexpected dependency additions
* suspicious install scripts
* ownership/maintainer changes
* unusual release changes
* provenance/integrity information
* unexpected package behavior

This allows Punch to detect:

```text
Known vulnerability
        +
Potential supply-chain anomaly
```

instead of being limited to known CVEs.

This should be a **stretch goal**, not something that delays the core system.

---

# 11. Resilience Metrics

Because the hackathon is specifically about multi-agent systems, measure the system itself.

Track:

```text
Task completion rate
Agent failure rate
Takeover success rate
Takeover latency
Evidence preservation
Critic rejection rate
Tool failure recovery
Total latency
Total model/tool cost
Human approval rate
```

Example demo metric:

```text
10 investigations

Agent failures injected: 7
Successful recoveries: 7
Average takeover: 2.4s
Context lost: 0%
Final task completion: 10/10
```

This proves that takeover is not just a UI animation.

---

# 12. Agent Architecture

Recommended roles:

```text
                    USER
                     │
                     ▼
              ORCHESTRATOR
                     │
                     ▼
                  PLANNER
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
 INVENTORY       VULNERABILITY   REACHABILITY
   AGENT            AGENT          AGENT
       │             │             │
       └─────────────┼─────────────┘
                     ▼
              IMPACT ANALYST
                     │
                     ▼
                ADVERSARIAL
                   CRITIC
                     │
             ┌───────┴────────┐
             │                │
           REJECT           ACCEPT
             │                │
             ▼                ▼
           REPLAN       REMEDIATION
                              │
                              ▼
                     VALIDATION SANDBOX
                              │
                              ▼
                       HUMAN APPROVAL
                              │
                              ▼
                       GITHUB EXECUTOR
```

---

# 13. Model-Agnostic Agent Slots

Keep your existing idea that agents are **slots**, not hardcoded models.

Example:

```text
Planner
→ Claude

Reachability
→ Gemini

Researcher
→ OpenAI

Critic
→ Claude

Backup
→ OpenCode / another available model
```

The orchestrator should be able to replace a failed model without changing the task architecture.

The system should maintain:

```text
Primary model
Backup model #1
Backup model #2
```

per role.

---

# 14. Most Important Product Principle

Do NOT keep adding agents just to say:

> “We have 8 agents.”

The architecture should demonstrate why each role exists.

The strongest story is:

```text
Detect
  ↓
Investigate
  ↓
Determine relevance
  ↓
Challenge conclusion
  ↓
Simulate fix
  ↓
Validate fix
  ↓
Human approval
  ↓
Execute
```

The **multi-agent system is the engine**.

The **security investigation is the application**.

The **takeover/recovery mechanism is the infrastructure differentiator**.

The **evidence + sandbox validation is what makes the output trustworthy**.

---

# 15. Final Product Pitch

Punch should be presented as:

> **Punch is an AI security investigation system for software supply chains. Instead of simply reporting vulnerable dependencies, Punch investigates whether a vulnerability actually affects your application, proves reachability, analyzes upgrade impact, validates proposed fixes in an isolated environment, challenges its own conclusions, and recovers automatically when an agent fails. Every conclusion is backed by an auditable evidence trail, and irreversible actions require human approval.**

The key demo should therefore NOT be:

```text
GitHub URL
→ 12 CVEs
```

It should be:

```text
GitHub URL
     ↓
Find vulnerability
     ↓
Investigate reachability
     ↓
Critic rejects weak evidence
     ↓
Replan
     ↓
Agent crashes
     ↓
Backup agent takes over
     ↓
Determine vulnerability is actually relevant
     ↓
Propose upgrade
     ↓
Test upgrade in sandbox
     ↓
Tests pass
     ↓
Human approves
     ↓
GitHub issue / PR
```

That is the story the entire product should be optimized around.
