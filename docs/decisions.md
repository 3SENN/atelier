# Quick decisions

Atelier makes many small judgment calls: is a reply waiting on you, does this
click buy or delete something, is this a search or a question. Today each one
is a rule (a keyword list, a closing "?", a fixed mode). Quick decisions adds
an optional **decision model** next to those rules: a non-generative model
that answers typed questions about a piece of text with probabilities, in
about a tenth of a second, and writes no text.

Off is the default and changes nothing. Turned on in Settings › Quick
decisions, the model takes over a decision only when it is sure and answers
in time; otherwise the rule decides, so nothing ever waits on it.

## Settings (DC-03)

Nothing is fixed to one provider or one model. Settings › Quick decisions,
in the Agent group next to Model and key:

1. **Use a decision model**: one switch, off by default. Off, Atelier's own
   rules decide and nothing is sent; your providers and models stay set up.
   Beside it, one status (Off, Not set up, Working, Not answering, Paused,
   Ready) and a line saying what to do next ("Connect a provider below to
   start") or how it is doing ("Working: clef-flash at Experiential Labs
   answers").
2. **Providers**: every provider in the table, each connected with its own
   key (Connect, Change key, Disconnect, Get a key), any number at once, and
   your own servers (a name, an address, a key only if it asks), as many as
   eight. Connecting the first one adds its suggested model to your list,
   switches it on and checks it.
3. **Your models**: the ones you chose, in order: the first answers; when it
   fails, is busy or reaches its rate limit, the next one does while there is
   time, then Atelier's rules. Each says how it is doing (Working in 480 ms, Not
   answering with the provider's own words, Paused, Not asked yet), and has
   Test, up, down and remove. Up to six. **Add a model** lists what each
   connected provider offers, read live from its model list, with its price
   per million tokens read, Free, and "no data kept" where the provider says;
   a search narrows a long list (OpenRouter's has dozens); any model id it
   doesn't list can be typed. A model added is checked by itself.
4. **How it's used**: Use it / Compare first.
5. **What it decides**, in three groups: when you type and talk (search or
   ask, voice into a field, who voice is for), your companion (waiting on
   you, clicks, labeling, effort, skills, setup picks), and tabs and memory.
   Each switch says what it sends; "Effort per message" says when your model
   can't change effort per message, and "What's worth remembering" where it
   applies.
6. **Where it differed.**

Until a provider is connected the page shows the switch and the providers;
after that your models come first. Model and key keeps one row, "Quick
decisions", that says whether it is on (and with which model, how many in
order, or that it isn't answering) and opens the page. Settings search finds
it by "decision model", "jev", "openrouter key", "backup model", "group tabs",
"effort per message" and the like.

## Decision models

A decision model takes a `state` (text or JSON) and a map of questions, and
returns an answer per question:

| Type | Asks | Answer |
|---|---|---|
| `noul` | Does this hold? | `noul`: the probability of yes |
| `choice` | Which of these 2 to 64 options? | `choice`, `probabilities` per option, `confidence` |
| `score` | Where on a 2 to 10 level scale? | `score` (may be fractional), `probabilities` per level, `confidence` |

Questions share the state but not each other. Output is free and input is
cheap ($0.042 per million tokens for TypeSafe's Jev 1.14, November 2026).

Providers speak one of two requests: TypeSafe's System One
(`POST …/v1/systemone`, `Authorization: Bearer <key>`), which Jev, Kev and
Clef take, or OpenAI's Decisions (`POST …/v1/decisions`), which GPT-6 Luna
takes. One client speaks both (DC-02, DC-19): Atelier's questions and readers
are written once in System One's shape, and the client turns them into
Decisions' named list (`predicate`, `choice` with `choices`, `score` with
`levels`) and its answers back (a `refusal` reads as an even spread, so the
rule decides). A Luna model id or a `/decisions` address picks Decisions;
everything else is System One.

| Provider | Decision address | Lists models at | Suggested to start | Notes |
|---|---|---|---|---|
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` | `/v1/models` | `jev-1.14.0` | Hosted; your TypeSafe key |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `/api/v1/models?output_modalities=decisions` | `typesafe/jev-1.14` | One key for 36 decision models from many makers (Jev, Clef, GPT-6 Luna, Liquid, Perplexity, Microsoft, Upstage and more, three of them free on 12 November 2026), all through System One's request; its router answers `refusal` where a model declines a question, read as unsure |
| Experiential Labs | `https://api.experientiallabs.ai/v1/systemone` | `/v1/models` | `clef-flash` | A gateway; your `xpl_` key. It also serves `clef`, `jev-latest` and `gpt-6-luna-decisions` (sent to its `/v1/decisions`), each listed with its price and data policy. Its Clef models are listed with zero data retention and no training; `jev-latest` there is passed on to TypeSafe without those terms, and Luna to OpenAI without training |
| OpenAI Decisions | `https://api.openai.com/v1/decisions` | `/v1/models` | `gpt-6-luna` | Your OpenAI key; $0.10 per million tokens read |
| On this computer | `atelier-device://nano/v1/systemone` (no network) | itself | `atelier-nano` | Atelier's own model, below; no key, nothing sent anywhere; listed first |
| Your own server | any address (`/v1/systemone` or `/v1/decisions` added by model) | next to it | | Any other System One or Decisions service, or a server you run: Kev (Apache-2.0, Qwen-based, MLX on Apple Silicon) and the like; a key only if it asks |

The providers are one table (`PROVIDER_DEFAULTS` in src/shared/decisions.ts):
each entry has its decision address, the request it takes (or "auto", by
model), where it lists models and whether that list holds decision models
only, a model to suggest, and where to get a key. Adding a provider is an
entry there with its name and description in the decisions strings; the
settings page, the key store, the services and the eval follow. Anything
that is not listed works as a server of your own.

Model ids are whatever the provider calls them, pinned versions where it has
them (an alias such as `jev-latest` moves under you); each model in your list
shows which version answered last, and a change of version is logged. Note
that probabilities differ between models, so a model new to Atelier is worth an
eval run (DC-06) before it decides alone; OpenRouter notes that some makers
(ScaleDown, Respan) expect their own state shapes.

**Rate limits and failures.** A 429 is retried once; if it holds, that model
sits out for a minute (or the provider's Retry-After, at least five seconds
and at most ten minutes) and the
next model in your list answers; with all of them paused, Atelier's rules decide
and routines and packs use the Claude engine. A model that fails, is busy or
can't be reached hands over to the next while there is time left (300 ms or
more); a timeout leaves none, so the rule decides. Settings shows each model's
state, with what the provider said (redacted and cut to 200 characters). A free Experiential Labs key allows 10 requests a
minute per free model (`jev-latest`, `clef`); past that it answers "Enable
Keep going on credits to continue", which is a switch in your account there,
not something Atelier can turn on. `gpt-6-luna-decisions` is paid per token
there from the first request.

**The slow tail (DC-20).** A gateway answers about one request in five in
more than a second, at random: measured on Experiential Labs, one request
missed the click guard's 1.2 s 8 times in 40, while the faster of two sent
together never did. So a decision someone waits on (is a reply waiting on you, voice, the
companion's clicks, search or ask, effort, skills; never the batch uses, which
send many requests at once) that has no answer after 250 ms is asked again,
and the first answer wins; the other is cancelled. In 40 live clicks that took misses from 4 to 0 and
the 90th percentile from 1.2 s to 0.76 s. An answer within the quarter
second (TypeSafe's own API usually takes a tenth) sends no second request;
your own server on this computer (localhost, 127.x, 0.0.0.0, ::1) and a
model that answered with a rate limit this session never get one; a 429
keeps the second from going out, and with both out the one that met it stops
without its retry. The usage ledger counts a second request's input tokens, and the
answer time shown is from the first send.

## On this computer

Atelier's own decision model (`device` in `PROVIDER_DEFAULTS`) answers Atelier's questions without a key, without
the network and without sending anything anywhere. It is a small multilingual encoder (all 22 layers of
mmBERT-small, a 44k-token vocabulary trimmed for English, Dutch, German, French and Spanish, 54 MB with int8 layers
and a 4-bit embedding table: atelier-nano v0.3), distilled from Perplexity's decision models
(pplx-decider-flash-v1.3, checked against v1.3's 26B) on Atelier's own questions. Atelier's fixed questions reach it
as a one-token tag instead of their wording, so a question is about 60 tokens and takes about 10 ms on two threads
of an ordinary CPU; open questions (label_items, routines, packs) keep their full wording.

- It runs in a utility process (src/main/decisions/device.ts, deviceHelper.ts) that starts on the first
  question (under a second, loading the model) and stops after five quiet minutes; a crash is a failed request, so
  the rule decides, and three in a row make it unavailable until Atelier restarts. Requests to
  `atelier-device://` go there through the decider's fetch, so timeouts, compare mode, comparisons and the
  readers' cutoffs work as for any provider, and it is never hedged (a second request would only queue).
- Its files (model, tokenizer, vocabulary map, per-decision calibration) are in Resources/decision-model in a
  build and native/decisions/build in development. `node scripts/fetch-decision-model.mjs` (part of
  `npm run package`) downloads the pinned version from the atelier-decisions project on Hugging Face (nano v0.3,
  saved as v0.6) and checks every file's size and SHA-256; `ATELIER_DECISION_MODEL_SRC=<export>` copies a local
  export instead, and `ATELIER_DECISION_MODEL` points a run elsewhere. Without them the provider reads Not
  installed and nothing changes.
- It answers Atelier's own decisions only. Questions that are not Atelier's (label_items, routine conditions,
  packs) get `refusal`, read as an even spread: on questions and text it never saw, its sure answers contradicted
  the teacher's 6% of the time (36% for one kind), against under 1% on Atelier's own, so the rule, or Claude
  where a caller falls back to it, decides those.
- It declines text it can't read: when under 70% of a state's letters are Latin script, or over 10% of its tokens
  are raw bytes (characters outside its vocabulary), every question gets `refusal`. Measured on unseen requests in
  20 languages: English, Dutch, German, French and Spanish, and Italian, Portuguese, Swedish and Indonesian too,
  contradict the teacher in at most 1.3% of answers and are answered; Russian, Greek, Arabic, Chinese, Japanese,
  Korean, Hindi, Hebrew and Thai are declined (Arabic without the guard: 6.7% contradicted, 15% sure where the
  teacher wasn't), and so are most Polish and Turkish texts.
- Its temperatures are fitted per decision on held-out teacher answers with Atelier's costs: a sure answer the
  teacher contradicts costs most; for "worth remembering", voice and dictation, being sure where the teacher was
  unsure costs more than handing back to the rule, and for the click guard a missed stop does.
- Measuring it: the eval above runs against it like any server (`runtime/node` in the model project serves the
  same files on 127.0.0.1), and the model project keeps the training data, the teachers' answers and a parity
  check between this runtime and its training code.

### New kinds of questions: atelier-mini (an optional download)

What the small model declines or is unsure about can go to a larger one on the same computer: atelier-mini
(Qwen3.5-2B read the way a decision model reads, 1.3 GB with 4- and 5-bit weights, run by llama.cpp's
`llama-server` on the CPU). It is not part of Atelier's download: Settings › Quick decisions › On this computer
offers it under "New kinds of questions" once the small model is ready, and it can be removed there.

- **The cascade** (src/main/decisions/device/cascade.ts): every question goes to the small model first. A
  `refusal` (an open question, text it can't read) or an answer Atelier's reader would not take (readers.ts, the
  same cutoffs as uses.ts) goes to the mini; what the mini is unsure about stays unsure, so the rule decides. A
  reply says which model answered each question (`routes`), and `model` reads `atelier-nano+mini` when the mini
  answered any.
- **What it buys** (measured in the model project, v0.6, analysis/cascade.py): on Atelier's own held-out decisions
  the pair decides 77% (the small model alone 72%) and is right on 94% of those, with 28% of questions reaching
  the mini; Atelier's eval passes 10 of 10 tests and email labeling is answered instead of declined. On kinds of
  questions the small model never saw it decides 50-78% and is right on 87-98% of those; on numbers checked
  against the true answer, 60% and 89%. On security questions with known answers (credentials in a message, a
  prompt injection, a link or download that isn't what it says) it decides 93% and is right on 94%. On rules
  applied to the specifics on a page (a booking, a renewal, an entry that has to meet two to four conditions and an
  exception) it decides 78% and is right on 84%.
- **Where it is weak**: it is still sure and wrong on 5% of those security questions and on 13% of the rules
  questions (19% for kinds of rules it never trained on): never the only guard there. Arithmetic in several steps
  (percentages, totals) it mostly leaves to the rule: it decides 16% of those.
- **Cost**: about 0.3-0.7 s a question (so live decisions with a budget under a second mostly keep the rule when
  the small model is unsure, and a slower computer leaves more of them to the rule), up to 2 GB of memory while
  the helper runs, a few seconds to load cold. It loads on
  the first question the small model leaves open, not at start-up, and stops with the helper after five quiet
  minutes. A stopped or timed-out request is cancelled in the helper too, so the mini's queue moves on.
- **Its server**: the helper starts `llama-server` (the folder's `server/`, llama.cpp's CPU build for this
  platform) on 127.0.0.1 at a free port, sends it token ids and reads the hidden state at the answer marker; the
  readout and the per-decision temperature are applied in the helper (mini.ts). The helper tells device.ts the
  server's process id, and device.ts stops it with the helper: a killed utility process would leave it running on
  Windows.
- **The download** (src/main/decisions/deviceMini.ts): every file is listed in `device/miniManifest.ts`, which
  ships with Atelier, with its size and SHA-256 (made by the model project's tools/mini_dist.py from the files it
  hosts), so whoever serves the files can't change what runs. Files go to `<data>/decision-model-mini.partial`, are
  checked as they stream in, and the folder is swapped in whole only when all match; a stopped download resumes
  with a range request. It needs the model's size plus 200 MB free. Downloads go through Electron's `net` (the
  system's proxy). The files are hosted on Hugging Face (`3SENN/atelier-decisions`, under `dist/<version>/`), with
  llama.cpp's CPU server for Windows (x64, arm64), macOS (arm64, x64) and Linux (x64, arm64). While the manifest has
  no download location (`base` empty), or no server build for this platform, the row isn't shown.
- **Development**: `ATELIER_DECISION_MINI=<folder>` uses a folder as it is (the model project's runtime folder plus
  a `server/` with llama-server), never downloaded into or removed; `ATELIER_DECISION_MINI_URL=<base>` tries a
  download location. `ATELIER_MINI_PARITY=<runtime folder> npx vitest run tests/decisionsDeviceMini.test.ts` checks
  that mini.ts makes the training code's token ids (608 of 608).

### Browser tasks: atelier-step (an optional download)

"Order the Trailrunner 2 in size 43", "fill in this form", "find me this": in each, someone has to decide on every
page what to do next. atelier-step does that on this computer. Your companion writes the task down once (the goal,
where to stop, the values to type) and atelier-step takes it page by page through the `browser_steps` tool.

- **The model** (src/main/decisions/device/step.ts, stepFormat.ts): atelier-nano's encoder with three heads, from the
  atelier-decisions project (step-v0.1, docs/step-model.md there). One pass per page answers the operation (click,
  type, done, blocked), which control, and for every field which of the named values goes in. 55 MB, about a tenth
  of a second a page on two CPU threads. It never writes text: what it types is one of the values it was given.
  The version's calibration (step.json) is applied, so "sure" means what the cutoffs below take it to mean.
  `ATELIER_STEP_PARITY=<model folder> npx vitest run tests/decisionsStep.test.ts` checks that this runtime makes the
  training code's token ids and logits on the version's fixtures.
- **Where it runs**: in the decision helper (deviceHelper.ts), as a `{ id, step }` message next to the decision
  requests; device.ts starts a new helper when it is installed or removed. It runs without the small decision model
  too (the helper then gets '' as the model folder and answers only steps).
- **The download** (feature.ts, the mini's installer with `needsServer: false`): four files, 57 MB, listed in
  `device/stepManifest.ts` with their sizes and SHA-256 and fetched from the version's tag on Hugging Face
  (`3SENN/atelier-decisions`, `releases/step-v0.1/model/`), so the files never change under a version. Settings ›
  Quick decisions › On this computer shows it as "Browser tasks": Download, progress, Stop, Remove.
  `ATELIER_STEP_MODEL=<folder>` uses a folder as it is (in smoke runs too).
- **The tool** (src/main/agent/tools/browserSteps.ts): offered to a new chat with the browser once atelier-step is
  here, never in routines. Each page is read by the page bridge's `stepPage` (controls and short text lines in page
  order, with their references and the form or page region each belongs to). An operation is taken at 0.6, a control
  or a value when it is at least 0.5 and 1.5 times the next one.
  - **Read**: each page through the site rules (as read_page) and the pause, so a blocked site is never read.
  - **Click**: through the chat's own `left_click` (AgentSession.chatBrowser), so the pause, site rules, click guard
    and approvals are the agent's own. A consequential click (paying, buying, sending, posting, deleting, an account
    or security change, by the guard's words and their Dutch, German, French and Spanish ones) goes back to the
    companion unless the goal asks for it, whatever the approval mode; paying always does.
  - **Type**: into an empty field, then every other empty field of the same form or region it is sure of, through
    `form_input`. The header's search box is never filled along with a checkout form, and password, card and
    one-time-code fields never.
  - **Handed back** to the companion, which carries on with its own browser tools: when it isn't sure, when no value
    it was given fits, when the person declines a click, when it would go in circles (the same operation on the
    same control within four), at a second add to the cart in one run, when the page stops changing, and after its
    steps (15 by default, at most 30).
  - **Done and blocked** end the run, and the companion is told to check the page itself: atelier-step can be wrong
    about "done".
- **The card**: a `browser-steps` event upserted by id while it runs ("Steps on this computer"), with the latest
  steps and why it ended.
- **What it is good at, measured** (the model project, step-v0.1): the kinds of flow it was trained on, in languages
  it never saw for them, right on 97% of whole steps; on real websites it never saw, the right control 59% of the
  time among 15-60, and calibrated it decides 28% of those and is right on 89%. In the project's lab (a shop order,
  a product search, a two-page Dutch form) with Claude only for what it wasn't sure of, all three ended right in
  10-18 s instead of 35-81 s. Alone it finishes none of them: it is a helper for routine stretches, never the only
  judge.

## The rule-first contract (DC-01)

Every one of Atelier's decisions calls `decider().decide({ use, rule, request, read })`
(src/main/decisions/service.ts):

- `rule` is what the rule decided. It comes straight back when the provider is
  off, the use is switched off, the window or chat is private, the model
  fails, or it does not answer within the use's time limit.
- `request` is built only when the model is consulted.
- `read(result, rule)` turns the answers into the rule's shape, or null when
  the model is not sure enough (the cutoffs below). A slow rule (a Claude
  call) can run alongside the model, and `read` may keep parts of it.

**Compare mode** returns the rule every time and runs the model alongside, so
the person can see where it would have decided otherwise before letting it.
Either way, every disagreement is noted (DC-05).

## Atelier's own decisions (DC-08 to DC-12, DC-14 to DC-18)

All questions live in src/main/decisions/uses.ts.

| Use | Rule today | With a sure model | Time limit |
|---|---|---|---|
| `needsYou` (DC-08) | the reply's last line ends in "?" | waits only when the work is blocked on an answer; "Want me to…?" no longer lights the needs-you badge, "Tell me which one you'd like." does | 1.5 s, at the end of a run |
| `dictation` (DC-09) | with "rewrite the field" on, every voice turn into a field waits on the companion | plain dictation is typed at once; edit requests still go to the companion | 0.9 s |
| `agentClicks` (DC-10) | an English keyword list on the control's name | a second opinion in any language when the list found nothing; it can only **add** a stop, never remove one, so page text cannot talk its way past the guard. The same control on the same page is judged once every ten minutes, so a task that clicks it again doesn't wait again | 1.2 s |
| `setup` (DC-11) | the setup extraction's picks (one Claude call) | tech level, reply style and interests settled by the model where it is sure, alongside the same call | 5 s |
| `searchOrAsk` (DC-12, DC-14) | the new tab composer's mode; in the address bar, the typed row (search or go) first | after a 350 ms pause in typing, the new tab's top row (and Enter) becomes a search or a question, and in the address bar a sure "ask" moves the Ask row to the top so Enter asks the companion; picking a mode or a row by hand wins; addresses and private windows never ask | 0.9 s, reused a minute per text |
| `voiceTarget` (DC-12) | a focused field takes the voice turn | in auto mode, "open my calendar" goes to the companion instead | 0.7 s |

| `effort` (DC-15) | the chat's effort | a sure "no thinking needed" ("thanks", a one-line fact) runs the turn at low effort; sure "hard work" (research, planning, code, or "yes, go ahead" after a plan, since the end of the previous reply goes along) one step above; the model the person picked never changes; messages a person sent only, never routines, helpers or Continue; models with per-message effort only (not Haiku) | 0.8 s |
| `skills` (DC-16) | the companion's own skills, by name, the first 40 | at the first message, the skills that fit are listed first and marked, the ones that sure don't fit last; 20 per request | 1.5 s |
| `memory` (DC-17) | the nightly tidy and "Build from past chats" read every new chat | a chat the model is sure holds nothing lasting (a lookup, a one-off task) is left out; a tidy with nothing left makes no Claude call | 5 s per chat |
| `tabs` (DC-18) | "Group tabs" groups by site (two or more tabs on one site) | each tab goes into one of the window's own groups where it belongs, or a topic group (twelve topics) with two or more tabs; the rest by site. Only each tab's title and host are sent; a run waits 4 s at most, and tabs that joined a group go to the end of its block | 2 s per tab, four at a time |

Effort per message never rewrites the conversation, which would throw away
its prompt cache: on the API key a system message carrying only
`output_config.effort` follows the person's message (the
`mid-conversation-output-config-2026-07-01` beta) and the next message
switches back the same way; another engine gets the message's effort with
the turn (`BackendTurn.effort`) and applies it its own way. The changes are kept
with the chat (`effortMarks`), and the reply's Details say "Low, picked for
this message".

`effort` and `memory` start off even with a provider chosen: they send each
message you type and whole chats, where the others send a line, a label or
a title. Each use has its own switch in Settings. A verdict reused (`DecideCall.reuse`)
is kept per provider, address and model, and never stands in compare mode.

## Your companion (DC-13)

`label_items` is a client tool (both engines) for the companion's own work:
labeling, sorting, filtering or checking many items it has read, such as
emails, products, search results, table rows or tabs. It takes up to 50 items
(each with an id and its text), one to five questions in the System One shape,
and an optional shared context ("emails in Sam's work inbox"). Each item is one
request, four at a time; the answers are read with the same cutoffs as Atelier's
own (yes at 0.7, no at 0.3, a choice at 0.75, a level at 0.6) and come back as
the verdict and its probability, or "unsure" with what the model leaned
towards, for the companion to judge itself. A rate limit, a refused key or an
unreachable provider stops the rest, and those items say so.

It is offered to a new chat while a decision model is set up and "Labeling and
sorting in tasks" is on, and never in a private chat; the system prompt then
has one line on when to use it. `browser_steps` (Browser tasks, above) is the
other decision-model tool: it runs on this computer, so private chats have it
too. There is no Claude
fallback on purpose: the companion is the Claude engine, so without the model
it simply judges the items itself. What is sent is the items' text and the
context.

## Routines and packs (DC-07)

Two callers that are not Atelier's own decisions use `decider().ask()`: the
decision model when one is on, otherwise the person's Claude engine (their API
key, or another engine, through QuickModel), so both work on every engine. A
failing or rate-limited decision model falls back to Claude too; for a pack
that call then counts against the model budget, not the decision budget, and
the state is held to the same 24,000 characters on Claude. Claude's answers carry
`source: "claude"`: its stated confidence is less calibrated, so every cutoff
is raised for it (`stricter()`).

- **Routine conditions.** A routine can have "Only tell me if…" (the editor,
  and `notify_if` on the companion's `propose_routine`). After a run that
  finished, the condition is asked as a `noul` about the run's closing reply.
  Only a clear no (≤ 0.3, ≤ 0.15 on Claude) keeps it quiet: the run is still
  recorded and marked read. A failed check, an empty reply or an unsure answer
  notifies, since a missed result costs more than an extra one.
- **`atelier.ai.decide(state, questions)`** for packs, with `permissions.model`.
  On a decision model it has its own budget, 600 an hour and 5,000 a day;
  on Claude each call counts against the 60-an-hour model budget. The `sorter`
  starter shows it: topics and urgency for a list of messages, "unsure" when
  the model is not sure. See [apps.md](apps.md) › Atelier as the AI engine.

## Thresholds

Following TypeSafe's confidence guidance: act when sure, keep the rule
otherwise, and demand more where a wrong answer costs more.

| Reader | Cutoff |
|---|---|
| `yesNo(answer, yes, no)` | yes at ≥ 0.7, no at ≤ 0.3, nothing in between (per use: needsYou 0.75/0.25, dictation 0.85, setup interests 0.75/0.25) |
| `sureChoice(answer, min)` | the chosen option's own probability ≥ 0.75 (agentClicks 0.8, searchOrAsk 0.8, voiceTarget 0.85) |
| `sureLevel(answer, min)` | the likeliest level holds ≥ 0.6 |
| `stricter(result, cutoff)` | Claude's answers: halfway from the cutoff to 1, at most 0.97 |

## Privacy and safety (DC-03, DC-04)

- Off until you choose a provider; each use can be switched off.
- Only the text being decided about is sent: the end of a reply, a control's
  label with its page title and site, what you typed or said. Nothing from a
  private window or chat. Requests are cut to 24,000 characters.
- Keys are kept per provider (and per server of yours) in one file sealed by
  this computer's secure storage (`decision-keys.bin`), registered for log
  redaction, and never sent to a page. A server's id is random and never
  reused, its key goes when it is removed (and any left over at the next
  start), and an address with a name or password in it is refused. Reset
  Atelier clears the comparisons with the settings and the keys with the other
  secrets.
- Page text is only ever the state being judged; the questions say so, and
  the click guard's model can only add stops.
- Every call is a usage row of kind "Quick decisions" (tokens only; the cost
  meter stays Anthropic's).

## Comparisons (DC-05)

Where the model's sure answer differed from the rule, Atelier keeps a row on this
computer (`decision-comparisons.json`, the newest 200): the use, both answers,
how sure the model was, whether it was used, the version, and a redacted
160-character excerpt. Settings shows the newest 20 with how many decisions
were answered and how many differed; Settings › Your data can clear them.

## Measuring (DC-06)

tests/fixtures/decisions-eval.json holds labelled cases for each use, in
several languages. tests/decisionsEval.test.ts runs them through the same
questions and cutoffs against a real model:

```
ATELIER_DECISIONS_EVAL=typesafe ATELIER_DECISIONS_KEY=… npx vitest run tests/decisionsEval.test.ts --silent=false
ATELIER_DECISIONS_EVAL=experiential ATELIER_DECISIONS_KEY=xpl_… ATELIER_DECISIONS_MODEL=clef npx vitest run tests/decisionsEval.test.ts --silent=false
ATELIER_DECISIONS_EVAL=experiential ATELIER_DECISIONS_KEY=xpl_… ATELIER_DECISIONS_MODEL=gpt-6-luna-decisions npx vitest run tests/decisionsEval.test.ts --silent=false
ATELIER_DECISIONS_EVAL=custom ATELIER_DECISIONS_URL=http://127.0.0.1:8009 npx vitest run tests/decisionsEval.test.ts --silent=false
```

`ATELIER_DECISIONS_EVAL` is any provider in the table; `ATELIER_DECISIONS_PACE_MS`
spaces the requests out for a per-minute limit (6500 for 10 a minute).
Per use it reports accuracy on the cases the model was sure of, how often it
stayed unsure, whether a choice flips when its options are reversed, and the
median and 90th-percentile answer time; it fails below 80% or on any flip. Run
it before changing a question, a cutoff or the pinned version, and add a case
whenever a decision goes wrong in real use.

**First results** (10 November 2026, Experiential Labs, from this Mac).
How often each model was right when it was sure, how often it was unsure (the
rule decided), and answer times:

| Model | Right when sure | Unsure | Order flips | Median answer | 90th percentile |
|---|---|---|---|---|---|
| `clef-flash` | 29 of 29 | 17 of 46 | 0 | 0.4 to 1.2 s | 0.7 to 5.6 s |
| `clef` | 27 of 27 | 19 of 46 | 0 | 0.8 to 1.0 s | 1.0 to 3.2 s |
| `jev-latest` | 31 of 31 | 15 of 46 | 0 | 0.5 to 0.7 s | 0.9 to 2.8 s |

What the person gets, on `clef-flash`: Atelier's rules alone against the rules
with the model taking over where it is sure.

| Decision | Rules alone | With the model |
|---|---|---|
| Is a reply waiting on you | 5 of 10 | 10 of 10 |
| Voice into a field | 4 of 8 | 8 of 8 |
| The companion's clicks (stops when it should) | 5 of 12 | 9 of 12 |
| Search or ask | 5 of 10 | 8 of 10 |
| Who voice is for | 3 of 6 | 6 of 6 |
| Labeling 12 emails (`label_items`) | | topic 11 of 11 sure (1 unsure), "act today" 12 of 12, in 5.5 s |

The cases were written to include what the rules get wrong (polite closing
questions, other languages), so the rules-alone column is lower than in
everyday use; the gain is real but smaller there. All three models were right
every time they were sure; they differ in how often they are sure
(`jev-latest` most, on clicks especially) and in speed, which also varies from
run to run at the provider. `clef-flash` is the default there: fast, and with
zero data retention. The slow tail and an occasional first request of 3 to 4 s
mean some decisions fall back to the rule, as designed, and the cutoffs held
back sure-looking mistakes (`clef-flash` leaned "ask" for "weather amsterdam"
at 62%). The three clicks still missed are other-language controls the model
didn't flag; the keyword list stays the first line there.

**Second round** (11 November 2026, Experiential Labs; `clef-flash` was down
at the provider that day, answering 503 "all routes failed"). The full set on
`gpt-6-luna-decisions` through OpenAI's Decisions request, and the four new
decisions on `jev-latest` and `clef` too (right when sure, and rules alone
against rules with the model):

| Decision | `gpt-6-luna-decisions` | `jev-latest` | `clef` |
|---|---|---|---|
| Is a reply waiting on you | 8 of 9 sure; 5 → 9 of 10 | | |
| Voice into a field | 3 of 3; 4 → 7 of 8 | | |
| The companion's clicks | 4 of 4; 5 → 8 of 12 | | |
| Search or ask | 10 of 10; 5 → 10 of 10 | | |
| Who voice is for | 1 of 1; 3 → 4 of 6 | | |
| Effort per message (rule: the chat's effort) | 7 of 7; 3 → 10 of 12 | 8 of 8; 3 → 10 of 12 | 8 of 8; 3 → 9 of 12 |
| Worth remembering (rule: read every chat) | 5 of 5; 5 → 10 of 10 | 5 of 5; 5 → 10 of 10 | 5 of 5; 5 → 10 of 10 |
| Tab topic or own group | 12 of 12 | 11 of 11 (1 unsure) | 12 of 12 |
| Which skill fits (rule: none marked) | 9 of 9; 2 → 10 of 10 | 9 of 9; 2 → 10 of 10 | 9 of 9; 2 → 10 of 10 |
| Labeling 12 emails | 24 of 24, in 3.5 s | | |

Medians were 0.4 to 1.0 s (`clef` slowest). Luna's one mistake was a polite
"Should I also translate the PDF next to it?" read as waiting on you. The
tabs question first let `jev-latest` file "Hotels in Lisbon" under travel
instead of the person's own "Lisbon trip" group; it now says their own groups
come first, and all three models got that case right after.

In a real chat (Opus 5.5, Atelier's own system prompt and tools,
`label_items` answered by Luna), the companion sorted 10 emails
itself and handed 25 to `label_items` on its own, which answered all 25.

## Code

| Where | What |
|---|---|
| src/shared/decisions.ts | types, settings, limits, the answer readers, the services |
| src/main/decisions/client.ts | the System One client: timeout, one retry on 429/529, typed errors |
| src/main/decisions/service.ts | the decider: rule first, compare mode, ask() with the Claude fallback, comparisons |
| src/main/decisions/claude.ts | the Claude fallback through QuickModel |
| src/main/decisions/keys.ts | the sealed keys |
| src/main/decisions/uses.ts | Atelier's own questions and cutoffs |
| src/main/decisions/tool.ts | `label_items`, the companion's tool |
| src/main/agent/turnDecisions.ts | effort per message and the skills' ranking at a chat's first message |
| src/main/tabAutoGroup.ts | "Group tabs": the plan by site or by the model's answers |
| src/renderer/src/overlay/surfaces/address/enter.ts | the address bar's Ask row first, and Enter |
| src/main/decisions/feature.ts | wiring, the settings services, smoke's stand-in model |
| src/renderer/src/settings/agent/QuickDecisions.tsx | the settings sections |
| src/main/decisions/smoke.ts, smokeTabs.ts | `ATELIER_SMOKE_ONLY=decisions` |

## Not yet

- Connectors are not ranked into a chat. A chat's tools are fixed at its
  first message (so caching and earlier thinking stay valid), and a connector
  left out could never be used later in that chat; every enabled connector
  stays in.
- The on-device model loads in the background ten seconds after start when it is among your models, but stops
  after five quiet minutes, so the first question after a quiet spell waits for it to load again (under a second),
  which a voice decision's 0.7 s can miss (the rule decides).