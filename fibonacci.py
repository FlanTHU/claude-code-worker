import time
from functools import lru_cache


@lru_cache(maxsize=None)
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def fib_sequence(n: int) -> list[int]:
    return [fib(i) for i in range(n)]


if __name__ == "__main__":
    start = time.perf_counter()
    seq = fib_sequence(15)
    elapsed = time.perf_counter() - start

    print(seq)
    print(f"elapsed: {elapsed * 1000:.4f} ms")
