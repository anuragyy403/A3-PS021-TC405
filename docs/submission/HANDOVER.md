# Nighthawks PS-021 — Hand-over and Submission Checklist

Everything in this file is done **by the team** in the GitHub web UI. The project's
automation never changes repository settings (visibility, collaborators, ownership).

Repository: `https://github.com/anuragyy403/Nighthawks` · working branch: `phase-3a-recovery` · default branch: `main`.

---

## 1. Merge the work into `main` and push (if not done yet)

Phase 11 was prepared without merging or pushing (no permission was given). From the
repository root, after reviewing `git status` and `git log`:

```bash
git push origin phase-3a-recovery
```

```bash
git checkout main
```

```bash
git pull --ff-only origin main
```

```bash
git merge --no-ff phase-3a-recovery -m "Merge phase-3a-recovery: PS-021 prototype, tests, demo and deliverables"
```

```bash
git push origin main
```

If `git pull --ff-only` fails, `main` has diverged on GitHub: stop and look at what is there
before merging — do not force-push.

Optional release with the demo video (needs the GitHub CLI `gh`, logged in):

```bash
cd e2e && npm run demo:record
```

```bash
gh release create v1.0.0-hackathon --target main --title "Nighthawks PS-021 hackathon submission" --notes "Prototype, tests, demo assets. Experimental; not exactly-once; not MCP/A2A; not an IETF standard." docs/submission/Nighthawks-PS-021-Report.pdf docs/submission/Nighthawks-PS-021-Deck.pdf e2e/demo-output/<file>.webm
```

---

## 2. Make the repository private

1. Open the repository on GitHub → **Settings** (top tab; needs admin rights).
2. **General** → scroll to **Danger Zone** → **Change repository visibility**.
3. Choose **Make private**, read the warning, type the repository name to confirm.
4. Check: the repository header shows the **Private** label.

## 3. Add `aiori-hackathon` as a collaborator

1. **Settings** → **Collaborators** (on organization repositories: **Collaborators and teams**).
2. Confirm with your password / 2FA if asked.
3. **Add people** → search **`aiori-hackathon`** (<https://github.com/aiori-hackathon>) → select it.
4. Choose the role the organizers asked for (default **Write**; use **Admin** if they need it to accept the transfer later) → **Add**.
5. The invitation is pending until `aiori-hackathon` accepts it; it then appears in the collaborator list.

## 4. Transfer ownership (only after the request is accepted)

The Problem Statement asks that ownership is transferred to `aiori-hackathon` **after the
request is accepted**, by all teammates and the organizers' account. Agree the moment with the
organizers first.

1. **Settings** → **General** → **Danger Zone** → **Transfer ownership**.
2. New owner: **`aiori-hackathon`**. Keep the repository name **`Nighthawks`** (team name).
3. Type the repository name to confirm → **I understand, transfer this repository**.
4. The new owner must accept the transfer (GitHub sends them an email). Until then the
   repository stays with the current owner.
5. After the transfer, update local clones:

```bash
git remote set-url origin https://github.com/aiori-hackathon/Nighthawks.git
```

## 5. Fill in the open team items

- **README §40 Team** — names, roles and GitHub handles of every member (also §13 of
  `docs/submission/report.html`; rebuild the PDFs afterwards: `cd e2e && npm run report:pdf`).
- **README §41 License** — choose one (or state "all rights reserved"); add a `LICENSE` file if you choose an open licence.
- **Mentor answers** — record them (with the date) in README §28/§29 and `docs/TEST_RESULTS.md` §8:
  - what "interoperability and recovery test results" should cover (today: recovery results only;
    interoperability between independently implemented adapters is not claimed);
  - whether a specific IETF draft should be pinned instead of the experimental schema `v0.1-experimental`.
- **Organizer PDF template** — when *Proposed-structure-hackathon.pdf* is available, re-order the
  sections of `docs/submission/report.html` to match it exactly and rebuild the PDF.

---

## 6. Final submission checklist

| # | Item | Status / evidence |
|---|---|---|
| 1 | Two working mock adapters | Done — `backend/src/adapters/`; 265 backend tests |
| 2 | Dialog-state schema (experimental, clearly labelled) and state machine | Done — `docs/EXPERIMENTAL_SCHEMA.md`, `docs/assets/diagrams/lifecycle.svg` |
| 3 | Durable state / recovery mechanism | Done — SQLite file, `recover()`; Scenarios 4–5; E2E real process restart |
| 4 | Request deduplication | Done — `(dialog_id, seq)`; Scenario 3; E2E Da |
| 5 | Five disconnect/retry scenarios tested | Done — `docs/TEST_RESULTS.md` §4 |
| 6 | Recovery test results recorded | Done — `docs/TEST_RESULTS.md` |
| 7 | Interoperability test results | **Open** — not claimed; waiting for the mentors' definition |
| 8 | Demonstration of identity preservation and duplicate rejection, with pseudocode | Done — `docs/DEMO_SCRIPT.md`, `docs/PSEUDOCODE.md`, `node scripts/demo.mjs` |
| 9 | PDF in the repository | Done with a **provisional** structure — `docs/submission/Nighthawks-PS-021-Report.pdf`; re-order to the organizer template when available |
| 10 | Slide deck | Done — `docs/submission/Nighthawks-PS-021-Deck.pdf` |
| 11 | Repository named after the team | Done — `Nighthawks` |
| 12 | Work merged into `main` and pushed | **Team** — §1 above |
| 13 | Repository private | **Team** — §2 above |
| 14 | `aiori-hackathon` added as collaborator | **Team** — §3 above |
| 15 | Ownership transferred after acceptance | **Team** — §4 above |
| 16 | Team members and licence filled in | **Team** — §5 above |

Before the demo, run once: `cd e2e && npm run e2e` (16 browser tests) and keep the backup video
(`npm run demo:record`) on the presenting laptop.
