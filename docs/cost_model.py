"""Voice-agent cost model: naive realtime vs tiered vs tiered+cache.

All unit prices are PARAMETERS. They are 2026-10 order-of-magnitude
placeholders; replace with current vendor price sheets and rerun.
Usage: python cost_model.py
"""

# ---- unit prices (USD) -------------------------------------------------
ASR_BATCH_PER_MIN = 0.006      # short-audio batch transcription
ASR_STREAM_PER_MIN = 0.020     # streaming cloud ASR (per audio minute)
RT_IN_PER_MIN = 0.060          # realtime speech-to-speech, audio input
RT_OUT_PER_MIN = 0.240         # realtime speech-to-speech, audio output
LLM_IN_PER_M = 3.00            # text LLM input, per 1M tokens
LLM_OUT_PER_M = 15.00          # text LLM output, per 1M tokens
LLM_CACHED_IN_PER_M = 0.30     # cached prefix read, per 1M tokens (10%)
TTS_PER_CHAR = 0.000015        # $15 / 1M characters
ACK_CHARS = 8                  # "好，我先处理" -> short spoken ack
ACK_CACHE_HIT = 0.85           # pre-rendered ack clips, per voice + intent
RT_ACK_IN_SEC = 3              # realtime session just to say "thinking"
RT_ACK_OUT_SEC = 2

# ---- interaction profile ----------------------------------------------
PROFILES = {"typical": 40, "heavy": 200}   # voice interactions per working day
DAYS = 22

SPEECH_SEC = 7                 # user speech per interaction
RT_SESSION_IN_SEC = 25         # realtime: mic open incl. turn-taking silence
RT_SESSION_OUT_SEC = 18        # realtime: model audio
L2_AUDIO_SEC = 15              # long-form audio per interaction
PROMPT_IN_TOKENS = 1400        # system + session cards + tail
OUTPUT_TOKENS = 120
TTS_CHARS = 120

# ---- tier mix (share of interactions) ---------------------------------
# L3 only for conversational / barge-in turns; the spoken "I'm on it" ack
# is a cached TTS clip, NOT a realtime session.
MIX = {"L1": 0.67, "L2": 0.30, "L3": 0.03}
# cache effectiveness (share of calls that avoid full cost)
CACHE = {
    "prefix_hit": 0.80,   # share of prompt tokens served from prefix cache
    "semantic_hit": 0.20, # intent cache: skip LLM entirely
    "tts_hit": 0.25,      # reused audio
    "asr_hit": 0.10,      # repeated command audio fingerprint
}


def llm_cost(prompt_tokens, out_tokens, prefix_hit):
    cached = prompt_tokens * prefix_hit
    fresh = prompt_tokens - cached
    return (fresh * LLM_IN_PER_M + cached * LLM_CACHED_IN_PER_M
            + out_tokens * LLM_OUT_PER_M) / 1_000_000


def per_interaction(plan, rt_share=None):
    total = 0.0
    mix = dict(MIX)
    if rt_share is not None:
        rest = 1 - rt_share
        base_rest = MIX["L1"] + MIX["L2"]
        mix = {"L1": rest * MIX["L1"] / base_rest,
               "L2": rest * MIX["L2"] / base_rest,
               "L3": rt_share}
    for tier, share in mix.items():
        if plan == "naive":
            tier, share = "L3", 1.0
        if tier == "L3":
            c = (RT_SESSION_IN_SEC / 60 * RT_IN_PER_MIN
                 + RT_SESSION_OUT_SEC / 60 * RT_OUT_PER_MIN)
        else:
            asr_min = (SPEECH_SEC if tier == "L1" else L2_AUDIO_SEC) / 60
            asr = asr_min * (ASR_BATCH_PER_MIN if tier == "L1" else ASR_STREAM_PER_MIN)
            prefix = sem = tts_hit = 0.0
            if plan == "cache":
                prefix = CACHE["prefix_hit"]
                sem = CACHE["semantic_hit"]
                tts_hit = CACHE["tts_hit"]
                asr *= (1 - CACHE["asr_hit"])
            llm = 0 if sem else llm_cost(PROMPT_IN_TOKENS, OUTPUT_TOKENS, prefix)
            tts = 0 if sem else TTS_CHARS * TTS_PER_CHAR * (1 - tts_hit)
            ack = ACK_CHARS * TTS_PER_CHAR * (1 - ACK_CACHE_HIT) if plan == "cache" \
                else ACK_CHARS * TTS_PER_CHAR
            c = asr + llm + tts + ack
        total += c * share
        if plan == "naive":
            break
    return total


print("cost per voice interaction (USD)")
print(f"{'plan':<16}" + "".join(f"{p+'/day':>14}" for p in PROFILES) +
      "".join(f"{p+'/mo':>12}" for p in PROFILES))
for plan, label in [("naive", "A realtime"), ("tiered", "B tiered"), ("cache", "C tiered+cache")]:
    pi = per_interaction(plan)
    row = f"{label:<16}" + "".join(f"{pi:>14.4f}" for _ in PROFILES) + \
          "".join(f"{pi*PROFILES[p]*DAYS:>12,.2f}" for p in PROFILES)
    print(row)

a, b, c = per_interaction("naive"), per_interaction("tiered"), per_interaction("cache")
print(f"\nsavings B vs A: {(1-b/a)*100:.0f}%   C vs A: {(1-c/a)*100:.0f}%   C vs B: {(1-c/b)*100:.0f}%")

print("\nplan C: realtime share sensitivity (cost / interaction, typical user $/mo)")
for s in (0.0, 0.03, 0.05, 0.10, 0.20, 0.50, 1.0):
    pi = per_interaction("cache", rt_share=s)
    print(f"  rt {s*100:>5.0f}%  ${pi:.4f}   ${pi*PROFILES['typical']*DAYS:>7.2f}")

print("\nplan C cost split at 3% realtime (per interaction):")
for tier, share in MIX.items():
    if tier == "L3":
        c3 = (RT_SESSION_IN_SEC / 60 * RT_IN_PER_MIN + RT_SESSION_OUT_SEC / 60 * RT_OUT_PER_MIN)
        print(f"  L3 realtime: ${c3*share:.4f}")
    else:
        asr = (SPEECH_SEC if tier == "L1" else L2_AUDIO_SEC) / 60
        asr *= (ASR_BATCH_PER_MIN if tier == "L1" else ASR_STREAM_PER_MIN) * (1 - CACHE["asr_hit"])
        llm = llm_cost(PROMPT_IN_TOKENS, OUTPUT_TOKENS, CACHE["prefix_hit"]) * (1 - CACHE["semantic_hit"])
        tts = TTS_CHARS * TTS_PER_CHAR * (1 - CACHE["tts_hit"]) * (1 - CACHE["semantic_hit"])
        ack = ACK_CHARS * TTS_PER_CHAR * (1 - ACK_CACHE_HIT)
        print(f"  {tier}: asr ${asr*share:.4f}  llm ${llm*share:.4f}  tts ${tts*share:.4f}  ack ${ack*share:.5f}")

ack_cached = ACK_CHARS * TTS_PER_CHAR * (1 - ACK_CACHE_HIT)
ack_rt = RT_ACK_IN_SEC / 60 * RT_IN_PER_MIN + RT_ACK_OUT_SEC / 60 * RT_OUT_PER_MIN
print("\nspoken ack: pre-rendered clip vs realtime session (per ack)")
print(f"  cached TTS ack : ${ack_cached:.5f}")
print(f"  realtime ack   : ${ack_rt:.4f}   [{ack_rt/ack_cached:,.0f}x]")
print(f"  4,400 acks/mo  : cached ${ack_cached*4400:,.2f} vs realtime ${ack_rt*4400:,.2f}")
