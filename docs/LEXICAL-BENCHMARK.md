# Lexical index benchmark, 0.3.10

Measured on 2026-11-01 with Node v24.22.1 on win32, 13th Gen Intel(R) Core(TM) i7-13650HX. The baseline is the unpacked v0.3.9 release.

| Sources | Baseline median ms | Indexed median ms | Median reduction | Baseline p95 ms | Indexed p95 ms | Added database MiB | Indexed setup seconds |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10000 | 409.6 | 376.0 | 8.2% | 449.7 | 467.8 | 10.85 | 1.89 |
| 50000 | 2299.5 | 1992.6 | 13.3% | 3004.1 | 2601.3 | 56.62 | 12.56 |

Each scale uses 12 distinct queries repeated twice, with two preceding warm-ups, synthetic 1,024-dimensional unit vectors and top-5 full hybrid lookup. All 48 measured before/after card comparisons are exactly equal; unsupported-history queries return no cards. No model call is made. The comparison includes vector scanning, source checks, ranking and card generation, and excludes generating a real query embedding. It does not measure semantic-model accuracy.

The follow-up 10k snapshot is used in the main table. Its indexed p95 rose from 449.7 to 467.8 ms (about 4.0%), while its median decreased. The earlier 10k snapshot is retained in the raw JSON. The benchmark runs baseline then indexed on a single local computer, so shared CPU scheduling and warmed file data influence timing. These are observed synthetic results, not an exclusive-hardware performance guarantee.

Setup measures a synchronous benchmark build, including database opening and new-index construction. Production instead processes at most 16 rows per idle batch, yields between rows and uses the existing idle cadence. Its elapsed backfill time can be longer. Each source up to 8,192 characters is indexed. Pending and oversized sources remain in the exact verification path, including message tails. Large pending/oversized collections and broad common-word queries can still cost a full scan. The semantic vector scan remains linear.

Reproduce by downloading and unpacking v0.3.9, then running from this release directory:

`npm run benchmark:lexical -- /absolute/path/to/unpacked-v0.3.9 10000 50000`

The runner creates synthetic temporary databases and prints the report path. [Raw results](benchmarks/lexical-0.3.10.json) include hardware, query list, both snapshots and limits. [Component ownership](ARCHITECTURE-MATRIX.md) records the boundaries of each layer.
