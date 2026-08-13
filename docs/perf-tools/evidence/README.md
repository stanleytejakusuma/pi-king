# A/B evidence (2026-08-13) — tmux vs native, identical load

Raw VFR frame timestamps from the controlled A/B described in
`../../PERF-TMUX-SPEC.md` ("SETTLED"). Each line is a screen-repaint event;
inter-line gaps are the metric. Recordings themselves were transient
(/tmp/pi-audit/abtest/{A-tmux,B-native}.mov) and are not committed.

Reproduce the analysis:
    python3 -c "
    ts=[float(l.strip().rstrip(',')) for l in open('abtest-A-tmux-frametimes.txt') if l.strip().rstrip(',')]
    gaps=sorted((ts[i+1]-ts[i])*1000 for i in range(len(ts)-1))
    n=len(gaps); print('p50',gaps[n//2],'p90',gaps[int(n*.9)],'p99',gaps[int(n*.99)])"

Headline: p50 IDENTICAL (25ms both); tail diverges hard — p99 425ms vs 100ms,
stutters >100ms 14.1% vs 0.9%, freezes >500ms 3 vs 0.
