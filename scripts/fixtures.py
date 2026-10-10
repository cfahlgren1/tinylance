# /// script
# requires-python = ">=3.11"
# dependencies = ["pylance==13.0.0", "pyarrow>=21", "numpy>=2"]
# ///
"""Generate the test fixtures: small Lance datasets written by pylance, each with pylance's own
to_table() output in expected.json. Run with `uv run scripts/fixtures.py`."""

import gzip
import hashlib
import json
import math
import os
import shutil
from datetime import date, datetime, timezone

import lance
import numpy as np
import pyarrow as pa

OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")
VERSIONS = ["2.0", "2.1", "2.2"]
N = 2000
VOCAB = ["cat", "dog", "bird", "fish", "lizard", "horse", "cow"]
WORDS = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "lance", "arrow", "hub"]


def rng(seed):
    return np.random.default_rng(seed)


def sentences(r, n):
    return [" ".join(r.choice(WORDS, int(r.integers(3, 30)))) for _ in range(n)]


def scalars(n=N):
    r = rng(1)
    ids = np.arange(n, dtype=np.int64)
    return pa.table({
        "id": ids,
        "i8": pa.array(r.integers(-128, 127, n, dtype=np.int8)),
        "i32": pa.array(r.integers(-1000, 1000, n, dtype=np.int32)),
        "u8": pa.array(r.integers(0, 255, n, dtype=np.uint8)),
        "u64": pa.array(r.integers(0, 2**63, n, dtype=np.uint64)),
        "i16_null": pa.array([None if i % 7 == 0 else i % 300 for i in range(n)], pa.int16()),
        "f32": pa.array(r.standard_normal(n).astype(np.float32)),
        "f64": pa.array(r.standard_normal(n)),
        "flag": pa.array(r.integers(0, 2, n).astype(bool)),
        "ts": pa.array(1_700_000_000_000 + ids * 1000, pa.timestamp("ms")),
        "date": pa.array(r.integers(0, 20000, n, dtype=np.int32), pa.date32()),
        "const": pa.array([7] * n, pa.int32()),
        "all_null": pa.array([None] * n, pa.int64()),
        "big_i64": pa.array(r.integers(-(2**62), 2**62, n, dtype=np.int64)),
    })


def strings(n=N):
    r = rng(2)
    text = sentences(r, 200)
    return pa.table({
        "label": pa.array([VOCAB[i] for i in r.integers(0, len(VOCAB), n)]),
        "label_null": pa.array([None if i % 5 == 0 else VOCAB[i % 7] for i in range(n)]),
        "text": pa.array([text[i % len(text)] for i in range(n)]),
        "uniq": pa.array([f"row-{i:06d}-{r.integers(1e9)}" for i in range(n)]),
        "large": pa.array([text[i % 50] * 3 for i in range(n)], pa.large_string()),
        "empty_or_null": pa.array([None if i % 3 == 0 else "" if i % 3 == 1 else "x" for i in range(n)]),
    })


def vectors(n=1000):
    r = rng(3)
    return pa.table({
        "id": pa.array(np.arange(n, dtype=np.int64)),
        "emb": pa.FixedSizeListArray.from_arrays(pa.array(r.standard_normal(n * 32).astype(np.float32)), 32),
        "emb_f16": pa.FixedSizeListArray.from_arrays(pa.array(r.standard_normal(n * 8).astype(np.float16)), 8),
        "xyz": pa.FixedSizeListArray.from_arrays(pa.array(r.standard_normal(n * 3)), 3),
    })


def blobs(n=24):
    r = rng(4)
    imgs = [bytes(r.integers(0, 256, int(r.integers(2000, 12000)), dtype=np.uint8)) for _ in range(n)]
    text = sentences(r, 20)
    return pa.table({
        "id": pa.array(np.arange(n, dtype=np.int64)),
        "image": pa.array(imgs, pa.binary()),
        "image_large": pa.array(imgs, pa.large_binary()),
        "caption": pa.array([text[i % len(text)] * 40 for i in range(n)]),  # long strings use the full-zip layout
    })


def nested(n=N):
    r = rng(5)
    return pa.table({
        "id": pa.array(np.arange(n, dtype=np.int64)),
        "ints": pa.array([None if i % 11 == 0 else list(range(i % 6)) for i in range(n)], pa.list_(pa.int32())),
        "tags": pa.array([None if i % 13 == 0 else [VOCAB[k] for k in r.integers(0, 7, i % 4)] for i in range(n)], pa.list_(pa.string())),
        "point": pa.array(
            [{"x": float(i), "y": None if i % 4 == 0 else float(-i), "name": VOCAB[i % 7]} for i in range(n)],
            pa.struct([("x", pa.float64()), ("y", pa.float64()), ("name", pa.string())]),
        ),
        "boxes": pa.array([[[float(i), 1.0, 2.0, 3.0]] * (i % 3) for i in range(n)], pa.list_(pa.list_(pa.float32(), 4))),
    })


def long_lists(n=4000):
    # lists long enough to span mini-block chunks, so row slices start and end mid-chunk
    r = rng(6)
    lens = r.choice([0, 1, 5, 50, 1500], n, p=[0.2, 0.3, 0.3, 0.18, 0.02])
    return pa.table({
        "id": pa.array(np.arange(n, dtype=np.int64)),
        "ints": pa.array([None if i % 17 == 0 else list(range(int(k))) for i, k in enumerate(lens)], pa.list_(pa.int32())),
        "strs": pa.array([None if i % 19 == 0 else [f"w{i}-{j}" for j in range(int(k) % 40)] for i, k in enumerate(lens)], pa.list_(pa.string())),
    })


def zstd_strings():
    meta = {b"lance-encoding:compression": b"zstd"}
    t = strings()
    return t.cast(pa.schema([f.with_metadata(meta) for f in t.schema]))


def encode(v):
    """JSON-safe value that the tests can compare exactly against tinylance's output."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, bytes):
        return {"$bytes": len(v), "sha1": hashlib.sha1(v).hexdigest()}
    if isinstance(v, datetime):
        return {"$date": int(v.replace(tzinfo=v.tzinfo or timezone.utc).timestamp() * 1000)}
    if isinstance(v, date):
        return {"$date": (v - date(1970, 1, 1)).days * 86_400_000}
    if isinstance(v, (int, np.integer)):
        v = int(v)
        return v if abs(v) <= 2**53 else {"$int": str(v)}
    if isinstance(v, (float, np.floating)):
        v = float(v)
        return "NaN" if math.isnan(v) else v
    if isinstance(v, list):
        return [encode(x) for x in v]
    if isinstance(v, dict):
        return {k: encode(x) for k, x in v.items()}
    raise TypeError(f"cannot encode {type(v)}")


def write(name, table, version, **kw):
    path = os.path.join(OUT, f"{name}-v{version}.lance")
    lance.write_dataset(table, path, data_storage_version=version, **kw)
    return path


def snapshot(name, paths):
    """Every format version of a scenario must read back identically; store that output once."""
    expected = None
    for path in paths:
        ds = lance.dataset(path)
        rows = json.dumps([{k: encode(v) for k, v in row.items()} for row in ds.to_table().to_pylist()], separators=(",", ":"))
        if expected is not None and rows != expected:
            raise RuntimeError(f"{path} reads back differently from the other versions of {name}")
        expected = rows
        deletions = sorted({fr.metadata.deletion_file.file_type for fr in ds.get_fragments() if fr.metadata.deletion_file})
        print(f"{os.path.basename(path)}: {ds.count_rows()} rows, {len(ds.get_fragments())} fragments, deletions {deletions or '-'}")
    with open(os.path.join(OUT, f"{name}.expected.json.gz"), "wb") as f:
        f.write(gzip.compress(expected.encode(), mtime=0))


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    for name, fn in [("scalars", scalars), ("strings", strings), ("vectors", vectors), ("blobs", blobs), ("nested", nested), ("lists", long_lists)]:
        table = fn()
        snapshot(name, [write(name, table, v) for v in VERSIONS])

    snapshot("zstd", [write("zstd", zstd_strings(), v) for v in ["2.1", "2.2"]])

    # several fragments and versions, with both deletion file kinds. Lance switches from an Arrow
    # list to a Roaring bitmap above 5,000 deleted rows in one fragment.
    table = scalars(10000).select(["id", "i32", "f32", "i16_null"])
    paths = []
    for v in VERSIONS:
        path = write("deletions", table.slice(0, 2000), v, max_rows_per_file=700)
        lance.write_dataset(table.slice(2000, 8000), path, mode="append", data_storage_version=v)
        ds = lance.dataset(path)
        ds.delete("id IN (5, 6, 7)")
        ds.delete("id BETWEEN 2100 AND 8200 OR id % 10 = 3")
        paths.append(path)
    snapshot("deletions", paths)

    with open(os.path.join(OUT, "pylance.json"), "w") as f:
        json.dump({"pylance": lance.__version__, "pyarrow": pa.__version__}, f)
        f.write("\n")


main()
