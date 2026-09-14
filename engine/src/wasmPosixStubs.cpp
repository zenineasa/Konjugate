/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Emscripten's libc already provides real (if browser-sandboxed) implementations of fork(),
// dlopen(), shm_open() and mmap() -- everything providerRuntime.cpp's shared-memory provider
// transport needs except POSIX named semaphores, which it has no implementation of at all (there
// is no meaningful "cross-process" anything in a browser sandbox, so this was never going to be a
// real gap to close). This is the ONLY thing standing between the engine, entirely unmodified, and
// a clean WASM link -- see docs/proposals/webEdition.md.
//
// These are always-fail stand-ins purely to satisfy the linker: nothing in the equation-only
// validate/run paths the web build targets ever calls them (the sharedMemoryWorker provider
// execution mode -- the only caller -- requires spawning a real provider process first, which
// providerRuntime.cpp's own POSIX/Windows process-spawning calls already make impossible here).
// If this is ever actually invoked, failing loudly beats a silent wrong answer.

#if defined(__EMSCRIPTEN__)

#include <cerrno>
#include <semaphore.h>

extern "C" {

sem_t* sem_open(const char*, int, ...) {
    errno = ENOSYS;
    return SEM_FAILED;
}

int sem_close(sem_t*) {
    errno = ENOSYS;
    return -1;
}

int sem_unlink(const char*) {
    errno = ENOSYS;
    return -1;
}

}

#endif
