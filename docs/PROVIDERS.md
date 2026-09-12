# Cloud provider privacy & cost

What each provider's own current policy actually says about your data, as
of when this was written - **policies change, so re-check before relying
on this for anything that matters**. Ollama isn't listed: it's local, so
none of this applies.

**OpenAI and Claude (the API, not ChatGPT.com/claude.ai):** both state
that API inputs/outputs are **not** used to train their models by
default. That's specifically an API-vs-consumer-product distinction -
their consumer chat apps have different (and looser) defaults, but this
extension only ever calls the API. Neither is "no storage," though:
OpenAI keeps abuse-monitoring logs for a limited window by default (full
zero-retention needs a separate approved agreement with their sales team),
and Anthropic doesn't publish an exact default retention window in their
public docs - their Trust Center / Commercial Terms have the specifics if
that matters to you.

**Gemini**: whether Google trains on your data
depends on which *tier* of API key you're using, not just that you picked
"Gemini." A free API key (no billing account attached) **is** used "to
provide, improve, and develop Google products," with human reviewers able
to read de-identified API input/output. Attach billing and you're on the
paid tier, where Google states prompts/responses are **not** used to
improve their products. Check which key you actually have - don't assume.
(One wrinkle: in the EEA, Switzerland, and the UK, the stricter paid-tier
terms apply even to the free tier.)

**DeepSeek**: their privacy policy states
they store data in the People's Republic of China, and that they use it
"to train and improve our technology, such as our machine learning
models" **by default**, with an opt-out available via account settings
(not opt-in). Going this route means weighing both training use and a
China-based storage location, on top of the general cloud tradeoffs -
separately from any GDPR/UK-GDPR international-transfer question that
raises.

## Cost

Cloud calls are billed per token to whichever account the API key belongs
to. This extension doesn't estimate a dollar cost anywhere - provider
pricing changes too often to hardcode reliably, and it varies by model.
What it does show, before "Check Whole Document" / "Check Selected Text",
is how many API calls that run is about to make (cached paragraphs/
sections are free and excluded from the count) - see the guardrails
section in `docs/DETAILS.md`.
