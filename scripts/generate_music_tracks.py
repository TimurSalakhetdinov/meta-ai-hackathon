#!/usr/bin/env python3
"""
Procedural & AI Soundtrack Generator for "Dawn of Empires".

Supports:
1. `--mode synth` (default): Fast offline multi-layered stereo acoustic/orchestral synthesizer
   using pure Python standard library (wave, struct, math, random). Generates 16-second seamless
   valley theme (Alpine pastoral lyre, pan flute, warm strings, waterfall) and 12-second seamless
   battle theme (120 BPM driving war drums, rim clicks, staccato strings, brass stabs).
2. `--mode musicgen`: AI generation using Meta's `facebook/musicgen-small` via HuggingFace
   Transformers (requires torch and transformers).
"""

import argparse
import math
import os
import random
import struct
import sys
import wave

SAMPLE_RATE = 44100


def clamp(val, low=-1.0, high=1.0):
    return max(low, min(high, val))


def write_wav(filepath, left_channel, right_channel, sample_rate=SAMPLE_RATE):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    num_samples = len(left_channel)

    # Master limiter / soft-clipper to prevent harsh distortion
    max_amp = max(max(abs(s) for s in left_channel), max(abs(s) for s in right_channel), 0.001)
    gain = 0.88 / max_amp if max_amp > 0.88 else 1.0

    with wave.open(filepath, "w") as wav_file:
        wav_file.setnchannels(2)  # Stereo
        wav_file.setsampwidth(2)  # 16-bit PCM
        wav_file.setframerate(sample_rate)

        frames = bytearray()
        for i in range(num_samples):
            l = clamp(left_channel[i] * gain)
            r = clamp(right_channel[i] * gain)

            # Soft saturation
            l = math.tanh(l)
            r = math.tanh(r)

            int_l = int(l * 32767.0)
            int_r = int(r * 32767.0)
            frames.extend(struct.pack("<hh", int_l, int_r))

        wav_file.writeframes(frames)
    print(f"Generated soundtrack: {filepath} ({num_samples / sample_rate:.1f}s stereo)")


# =====================================================================
# SYNTHESIS ENGINES (Stereo Physical Modeling)
# =====================================================================

def synthesize_valley_theme(duration=16.0, sample_rate=SAMPLE_RATE):
    """
    16-second seamless Alpine Valley pastoral theme:
    - 75 BPM pastoral rhythm
    - D Dorian / A minor pentatonic lyre plucks (panned slightly left)
    - Breathy pan-flute counter-melody (panned slightly right)
    - Warm low string/cello pad chords (stereo center-wide)
    - Gentle mountain waterfall & breeze ambient wash (wide stereo)
    """
    num_samples = int(duration * sample_rate)
    left = [0.0] * num_samples
    right = [0.0] * num_samples

    # 1. Gentle mountain waterfall stereo ambient bed
    # Generate pink-filtered noise bed with slow gentle surge
    pink_l = 0.0
    pink_r = 0.0
    for i in range(num_samples):
        t = i / sample_rate
        # Slow 0.1Hz breathing surge
        swell = 0.030 + 0.010 * math.sin(2.0 * math.pi * 0.125 * t)

        white_l = random.uniform(-1.0, 1.0)
        white_r = random.uniform(-1.0, 1.0)
        pink_l = 0.94 * pink_l + 0.06 * white_l
        pink_r = 0.94 * pink_r + 0.06 * white_r

        left[i] += pink_l * swell
        right[i] += pink_r * swell

    # 2. Warm low string pad chords (4 bars, 4s per bar = 16s total)
    # Chord progression: Dm -> Fmaj -> Gsus -> Am
    pad_progression = [
        # (start_t, end_t, [freqs])
        (0.0,  4.0,  [73.42, 146.83, 220.00]),  # Dm (D2, D3, A3)
        (4.0,  8.0,  [87.31, 174.61, 261.63]),  # Fmaj (F2, F3, C4)
        (8.0,  12.0, [98.00, 196.00, 293.66]),  # Gsus (G2, G3, D4)
        (12.0, 16.0, [110.00, 220.00, 329.63]), # Am (A2, A3, E4)
    ]

    for start_t, end_t, chord in pad_progression:
        chord_samples = int((end_t - start_t) * sample_rate)
        start_idx = int(start_t * sample_rate)
        for c_idx, freq in enumerate(chord):
            pan_offset = -0.2 if c_idx == 0 else (0.2 if c_idx == 1 else 0.0)
            for s in range(chord_samples):
                idx = (start_idx + s) % num_samples
                local_t = s / sample_rate
                dur = end_t - start_t

                # Warm trapezoid envelope with soft attack and release
                if local_t < 0.6:
                    env = local_t / 0.6
                elif local_t > dur - 0.6:
                    env = (dur - local_t) / 0.6
                else:
                    env = 1.0

                # Warm lowpass-filtered saw approximation
                val = 0.045 * env * (
                    math.sin(2.0 * math.pi * freq * local_t)
                    + 0.40 * math.sin(2.0 * math.pi * freq * 2.0 * local_t)
                    + 0.15 * math.sin(2.0 * math.pi * freq * 3.0 * local_t)
                )

                left[idx] += val * (0.5 - pan_offset * 0.5)
                right[idx] += val * (0.5 + pan_offset * 0.5)

    # 3. Ancient Lyre / Celtic Harp Plucks (D Dorian / A Pentatonic)
    # Lyrical melodic phrasing across 16 seconds
    lyre_melody = [
        # (time, freq, vol)
        (0.2, 293.66, 0.16),  # D4
        (1.0, 440.00, 0.14),  # A4
        (1.8, 349.23, 0.15),  # F4
        (2.6, 587.33, 0.17),  # D5
        (4.2, 261.63, 0.14),  # C4
        (5.0, 392.00, 0.15),  # G4
        (5.8, 440.00, 0.16),  # A4
        (6.6, 523.25, 0.18),  # C5
        (8.2, 493.88, 0.15),  # B4
        (9.0, 392.00, 0.15),  # G4
        (9.8, 293.66, 0.14),  # D4
        (10.6, 329.63, 0.15), # E4
        (12.2, 349.23, 0.16), # F4
        (13.0, 329.63, 0.15), # E4
        (13.8, 261.63, 0.14), # C4
        (14.6, 293.66, 0.16), # D4 (peaceful resolve)
    ]

    for note_t, freq, vol in lyre_melody:
        start_idx = int(note_t * sample_rate)
        note_len = int(1.4 * sample_rate)
        pan = -0.22  # Lyre panned slightly left

        for s in range(note_len):
            idx = (start_idx + s) % num_samples
            local_t = s / sample_rate

            # Pluck envelope: 4ms attack, exponential decay
            env = math.exp(-local_t * 3.2)
            if local_t < 0.006:
                env *= (local_t / 0.006)

            # Dual-harmonic acoustic string model
            val = vol * env * (
                math.sin(2.0 * math.pi * freq * local_t)
                + 0.35 * math.sin(2.0 * math.pi * freq * 2.0 * local_t)
                + 0.12 * math.sin(2.0 * math.pi * freq * 3.0 * local_t)
            )

            left[idx] += val * (0.5 - pan * 0.5)
            right[idx] += val * (0.5 + pan * 0.5)

    # 4. Breathy Pan-Flute Counter-Melody (panned slightly right)
    flute_melody = [
        # (start_t, dur, freq, vol)
        (2.0,  1.8, 587.33, 0.10), # D5
        (6.0,  1.8, 659.25, 0.11), # E5
        (9.5,  2.2, 587.33, 0.11), # D5
        (12.8, 2.8, 440.00, 0.12), # A4 hold
    ]

    for start_t, dur, freq, vol in flute_melody:
        start_idx = int(start_t * sample_rate)
        flute_len = int(dur * sample_rate)
        pan = 0.28  # Flute panned slightly right

        for s in range(flute_len):
            idx = (start_idx + s) % num_samples
            local_t = s / sample_rate

            # Gentle swell envelope
            if local_t < 0.35:
                env = local_t / 0.35
            elif local_t > dur - 0.4:
                env = (dur - local_t) / 0.4
            else:
                env = 1.0

            # 5.2Hz subtle vibrato
            vibrato = 1.0 + 0.018 * math.sin(2.0 * math.pi * 5.2 * local_t)
            breath = 0.05 * random.uniform(-1.0, 1.0)

            val = vol * env * (math.sin(2.0 * math.pi * freq * vibrato * local_t) + breath)

            left[idx] += val * (0.5 - pan * 0.5)
            right[idx] += val * (0.5 + pan * 0.5)

    # Seamless loop boundary smoothing (crossfade first and last 0.15s)
    fade_len = int(0.15 * sample_rate)
    for i in range(fade_len):
        w = i / fade_len
        left[i] = left[i] * w + left[num_samples - fade_len + i] * (1.0 - w)
        right[i] = right[i] * w + right[num_samples - fade_len + i] * (1.0 - w)

    return left, right


def synthesize_battle_theme(duration=12.0, sample_rate=SAMPLE_RATE):
    """
    12-second seamless 2.5D Battle Arena theme:
    - Exactly 120 BPM (0.5s per beat, 2.0s per bar, 6 bars = 12.000s exact loop!)
    - Driving tribal war drums (deep Taiko kick on beats 1, 2&, 3, 4&)
    - Shield/rim clicks on beats 2 & 4
    - 16th-note syncopated sistrum / shaker pulse
    - Driving staccato strings ostinato in D minor
    - Powerful heroic brass fifths on bar downbeats
    """
    num_samples = int(duration * sample_rate)
    left = [0.0] * num_samples
    right = [0.0] * num_samples

    bpm = 120.0
    beat_dur = 60.0 / bpm         # 0.500s
    sixteenth = beat_dur / 4.0    # 0.125s
    num_sixteenths = int(duration / sixteenth)  # 96 steps

    # 1. War Drums / Taiko & Percussion Loop
    for step in range(num_sixteenths):
        step_t = step * sixteenth
        step_in_bar = step % 16  # 16 sixteenths per bar

        # Taiko Kick on steps 0 (beat 1), 6 (beat 2&), 8 (beat 3), 14 (beat 4&)
        if step_in_bar in [0, 6, 8, 14]:
            drum_len = int(0.24 * sample_rate)
            start_idx = int(step_t * sample_rate)
            vol = 0.38 if step_in_bar == 0 else 0.28

            for s in range(drum_len):
                idx = (start_idx + s) % num_samples
                local_t = s / sample_rate

                # 110Hz -> 36Hz pitch drop
                freq = 110.0 * math.exp(-local_t * 14.0) + 36.0
                env = math.exp(-local_t * 12.0)

                val = vol * env * math.sin(2.0 * math.pi * freq * local_t)
                left[idx] += val * 0.52
                right[idx] += val * 0.48

        # Shield/Rim Click on steps 4 (beat 2) and 12 (beat 4)
        if step_in_bar in [4, 12]:
            click_len = int(0.045 * sample_rate)
            start_idx = int(step_t * sample_rate)
            pan = -0.3 if step_in_bar == 4 else 0.3

            for s in range(click_len):
                idx = (start_idx + s) % num_samples
                local_t = s / sample_rate

                freq = 860.0 * math.exp(-local_t * 35.0) + 320.0
                env = math.exp(-local_t * 50.0)

                val = 0.16 * env * (
                    math.sin(2.0 * math.pi * freq * local_t)
                    + 0.4 * random.uniform(-1.0, 1.0)
                )

                left[idx] += val * (0.5 - pan * 0.5)
                right[idx] += val * (0.5 + pan * 0.5)

        # 16th-note shaker pulse on offbeats
        if step_in_bar in [2, 6, 10, 14]:
            shaker_len = int(0.04 * sample_rate)
            start_idx = int(step_t * sample_rate)
            for s in range(shaker_len):
                idx = (start_idx + s) % num_samples
                local_t = s / sample_rate
                env = math.exp(-local_t * 60.0)
                val = 0.05 * env * random.uniform(-1.0, 1.0)
                left[idx] += val * 0.5
                right[idx] += val * 0.5

    # 2. Driving Staccato Strings Ostinato (16th-note pattern in D minor)
    ostinato_pattern = [
        # Bar 0: Dm drive
        146.83, 146.83, 174.61, 146.83, 196.00, 146.83, 174.61, 146.83, # D3, D3, F3, D3, G3, D3, F3, D3
        220.00, 146.83, 174.61, 146.83, 164.81, 146.83, 174.61, 164.81, # A3, D3, F3, D3, E3, D3, F3, E3
        # Bar 1: Bb tension
        146.83, 146.83, 174.61, 146.83, 233.08, 146.83, 220.00, 146.83, # D3, D3, F3, D3, Bb3, D3, A3, D3
        196.00, 146.83, 174.61, 146.83, 164.81, 174.61, 164.81, 138.59, # G3, D3, F3, D3, E3, F3, E3, C#3
    ]

    for step in range(num_sixteenths):
        pitch = ostinato_pattern[step % len(ostinato_pattern)]
        step_t = step * sixteenth
        start_idx = int(step_t * sample_rate)
        note_len = int(0.10 * sample_rate)
        pan = -0.15 if (step % 2 == 0) else 0.15

        for s in range(note_len):
            idx = (start_idx + s) % num_samples
            local_t = s / sample_rate

            # Fast snappy staccato envelope
            env = math.exp(-local_t * 22.0)
            if local_t < 0.004:
                env *= (local_t / 0.004)

            # Filtered saw string tone
            val = 0.09 * env * (
                math.sin(2.0 * math.pi * pitch * local_t)
                + 0.50 * math.sin(2.0 * math.pi * pitch * 2.0 * local_t)
                + 0.25 * math.sin(2.0 * math.pi * pitch * 3.0 * local_t)
            )

            left[idx] += val * (0.5 - pan * 0.5)
            right[idx] += val * (0.5 + pan * 0.5)

    # 3. Heroic Brass Fifths on Bar Downbeats (every 2.0s)
    brass_bars = [
        # (time, [freqs], vol)
        (0.0,  [146.83, 220.00, 293.66], 0.14), # Bar 0: Dm (D3, A3, D4)
        (2.0,  [116.54, 174.61, 233.08], 0.13), # Bar 1: Bb (Bb2, F3, Bb3)
        (4.0,  [146.83, 220.00, 293.66], 0.14), # Bar 2: Dm
        (6.0,  [110.00, 164.81, 220.00], 0.13), # Bar 3: Am (A2, E3, A3)
        (8.0,  [146.83, 220.00, 293.66], 0.15), # Bar 4: Dm
        (10.0, [138.59, 207.65, 277.18], 0.15), # Bar 5: A7 / C# dim climax
    ]

    for bar_t, chord, vol in brass_bars:
        start_idx = int(bar_t * sample_rate)
        brass_len = int(0.70 * sample_rate)

        for c_idx, freq in enumerate(chord):
            pan = -0.25 if c_idx == 0 else (0.25 if c_idx == 1 else 0.0)
            for s in range(brass_len):
                idx = (start_idx + s) % num_samples
                local_t = s / sample_rate

                # Brass attack & bloom envelope
                if local_t < 0.04:
                    env = local_t / 0.04
                else:
                    env = math.exp(-(local_t - 0.04) * 3.5)

                val = vol * env * (
                    math.sin(2.0 * math.pi * freq * local_t)
                    + 0.55 * math.sin(2.0 * math.pi * freq * 2.0 * local_t)
                    + 0.35 * math.sin(2.0 * math.pi * freq * 3.0 * local_t)
                    + 0.20 * math.sin(2.0 * math.pi * freq * 4.0 * local_t)
                )

                left[idx] += val * (0.5 - pan * 0.5)
                right[idx] += val * (0.5 + pan * 0.5)

    # 12.0s at 120 BPM is an exact multiple of the 2.0s bar grid, making the loop mathematically seamless!
    return left, right


# =====================================================================
# META MUSICGEN-SMALL AI INTEGRATION
# =====================================================================

def generate_with_musicgen(output_dir, duration_valley=16.0, duration_battle=12.0):
    """
    Generates game soundtracks using Meta's facebook/musicgen-small model.
    Falls back gracefully to procedural synthesis if torch/transformers are missing.
    """
    try:
        import torch
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
    except ImportError:
        print("[MusicGen] Torch or Transformers not installed in environment.")
        print("[MusicGen] Falling back to high-quality procedural acoustic synthesizer...")
        run_synth_mode(output_dir, duration_valley, duration_battle)
        return

    print("[MusicGen] Loading Meta facebook/musicgen-small model...")
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
    model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to(device)

    prompts = {
        "valley_theme.wav": (
            "peaceful ancient mediterranean pastoral acoustic soundtrack, gentle lyre, pan flute, warm cello strings, alpine valley waterfall ambience, 72 bpm",
            int(duration_valley),
        ),
        "battle_theme.wav": (
            "epic ancient cinematic battle music, driving tribal war drums, taiko percussion, rhythmic brass fifths, strings ostinato, intense, 120 bpm",
            int(duration_battle),
        ),
    }

    for filename, (prompt, sec) in prompts.items():
        filepath = os.path.join(output_dir, filename)
        print(f"[MusicGen] Generating '{filename}' ({sec}s) with prompt: \"{prompt}\"...")
        inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
        max_tokens = int(sec * 50)  # ~50 tokens per second for MusicGen
        with torch.no_grad():
            audio_values = model.generate(**inputs, max_new_tokens=max_tokens)

        # Convert to numpy / wav
        audio_data = audio_values[0, 0].cpu().numpy()
        import scipy.io.wavfile
        scipy.io.wavfile.write(filepath, rate=model.config.audio_encoder.sampling_rate, data=audio_data)
        print(f"[MusicGen] Saved {filepath}")


def run_synth_mode(output_dir, duration_valley=16.0, duration_battle=12.0):
    valley_path = os.path.join(output_dir, "valley_theme.wav")
    battle_path = os.path.join(output_dir, "battle_theme.wav")

    print("Synthesizing 16-second seamless Alpine Valley Pastoral Theme...")
    l_v, r_v = synthesize_valley_theme(duration=duration_valley)
    write_wav(valley_path, l_v, r_v)

    print("Synthesizing 12-second seamless 2.5D Tactical Battle Theme...")
    l_b, r_b = synthesize_battle_theme(duration=duration_battle)
    write_wav(battle_path, l_b, r_b)


def main():
    parser = argparse.ArgumentParser(description="Soundtrack Generator for Dawn of Empires")
    parser.add_argument("--mode", choices=["synth", "musicgen"], default="synth",
                        help="Generator mode: 'synth' (fast offline stereo synthesis) or 'musicgen' (Meta AI model)")
    parser.add_argument("--output-dir", default="frontend/static/assets/audio",
                        help="Target directory for output audio files")
    parser.add_argument("--duration-valley", type=float, default=16.0, help="Duration in seconds for valley theme")
    parser.add_argument("--duration-battle", type=float, default=12.0, help="Duration in seconds for battle theme")
    args = parser.parse_args()

    if args.mode == "musicgen":
        generate_with_musicgen(args.output_dir, args.duration_valley, args.duration_battle)
    else:
        run_synth_mode(args.output_dir, args.duration_valley, args.duration_battle)

    print("\nSoundtrack generation complete!")


if __name__ == "__main__":
    main()
