# tashi-vertex 0.13.0: `Engine::recv_message` is not cancel-safe — use-after-free on future drop

## Summary

`tashi_vertex::Engine::recv_message()` returns a future whose `poll` implementation hands a raw `*mut self` pointer to the C library via `tv_message_recv`. The pointer is registered as a callback context inside libtashi-vertex's internal threads. The Rust wrapper has **no `Drop` impl** and the C library exposes **no cancel / unregister FFI**. If the future is dropped mid-poll — which is exactly what `tokio::select!` does to the losing branch — the C side later dereferences freed memory and the process SIGSEGVs inside a Tashi worker thread.

In practice this manifests as a seemingly random segfault shortly after the engine starts producing consensus events, with a stack trace in libtashi-vertex.dylib and no Rust frames pointing at user code. The crash is not reproducible on every run because the race depends on whether the C thread touches the pointer before the pending future is rescheduled or dropped.

## Affected version

- `tashi-vertex = "0.13.0"` (as published on crates.io)
- Crate source inspected at: `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tashi-vertex-0.13.0/`

## Root cause (code excerpts)

### `src/message.rs` — the `MessageRecieve` future

```rust
pub struct MessageRecieve<'a> {
    engine: &'a Engine,
    waker: Option<Waker>,
    ready: bool,
    // ... message slot ...
}

impl<'a> Future for MessageRecieve<'a> {
    type Output = crate::Result<Option<Message>>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.ready {
            // ... take and return message ...
        }
        self.waker = Some(cx.waker().clone());
        // Hand a raw pointer to *self* to C. C threads will later call back
        // through this pointer to flip `ready` and wake the task.
        unsafe {
            tv_message_recv(
                self.engine.ptr(),
                &mut *self as *mut Self as *mut c_void,
                Some(on_message_trampoline),
            );
        }
        Poll::Pending
    }
}

// No `Drop` impl anywhere in the file.
```

### `src/engine.rs` — no cancel API

```rust
impl Engine {
    pub async fn recv_message(&self) -> crate::Result<Option<Message>> {
        MessageRecieve::new(self).await
    }
    // ... no recv_cancel, no recv_abort ...
}
```

### The missing `Drop`

```rust
// Does not exist in 0.13.0 — if it did, it would need to call something
// like tv_message_recv_cancel() and synchronously block until the C side
// confirmed it no longer holds the pointer.
impl<'a> Drop for MessageRecieve<'a> { ... }
```

## Failure mode

1. Task `A` calls `recv_message()` and polls it once — `Poll::Pending` is returned, the raw pointer is now live in a Tashi worker thread.
2. Task `A` is inside a `tokio::select!` and another branch resolves first.
3. Tokio drops the `MessageRecieve` future → its memory is freed / reused.
4. Milliseconds later, the Tashi worker thread fires the callback, writes to the freed slot (possibly succeeding silently), or attempts to `wake()` a freed `Waker`.
5. Either the next allocation at that address corrupts → consensus state goes wrong → delayed crash, or the `Waker` vtable has been overwritten → immediate SIGSEGV inside libtashi-vertex.dylib.

Because the failure lives in a C thread, no Rust unwind/panic/backtrace is produced above the FFI boundary. The process simply dies.

## Reproducer sketch

```rust
let engine = Engine::start(&ctx, socket, opts, &key, peers, false)?;
let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

loop {
    tokio::select! {
        // `recv_message` is cancelled here every time the other arm wins.
        msg = engine.recv_message() => handle(msg),
        Some(_) = rx.recv() => { /* other work */ }
    }
}
```

Under load, this will SIGSEGV within seconds.

## Suggested upstream fixes

In order of preference:

1. **Give the C side a heap-owned, reference-counted context.** Allocate a `Box<Arc<Mutex<RecvSlot>>>` once when `recv_message` is called, hand the raw pointer to C, and implement `Drop` on the future that clears the slot so the C callback becomes a no-op. The box / arc only dies when both the Rust future **and** the C side have released their handle.

2. **Add `tv_message_recv_cancel(engine, ctx)` to the C API** and call it from `impl Drop for MessageRecieve`, synchronously waiting for confirmation that the C side has released the pointer. More invasive but gives explicit semantics.

3. **Document `recv_message` as !Cancel-Safe and forbid dropping the future.** The weakest option — relies on every user discovering the issue empirically (as we did).

## Current workaround in this crate

See `src/node.rs`. We:

1. Keep the engine on a `tokio::task::LocalSet` (required anyway, since `Engine` wraps `NonNull<TVEngine>` and is `!Send`).
2. Spawn a dedicated `tokio::task::spawn_local` recv task that runs `engine.recv_message().await` in a plain `loop` with no `select!`. The future is always polled to completion, so it is never dropped mid-poll.
3. Forward each result through an `mpsc::unbounded_channel`. The main engine loop `select!`s on that channel (which is cancel-safe) plus the tx-request channel (also cancel-safe).
4. Share the engine as `Rc<Engine>` between the recv task and the main loop — no `unsafe impl Send` required, keeps the FFI boundary honest.
5. On shutdown we deliberately do **not** `abort()` the recv task: aborting would drop the in-flight `recv_message` future and re-trigger the UAF. Instead we drop the channel, which causes the recv task to exit on the next iteration (after the in-flight recv completes or the engine is dropped).

This sidesteps the bug entirely without any unsafe code or workaround hacks — the only cost is one extra mpsc hop per consensus message, which is negligible at the event rates we see (tens/sec).

## Reporting

When opening an upstream issue, include:

- The reproducer above.
- A minidump / `lldb bt all` from a crashed process (the stack should be entirely in libtashi-vertex.dylib with no Rust frames).
- A reference to this document.
