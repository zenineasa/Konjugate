/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A stand-in for a web C++ provider (engine/src/providerWorker.cpp compiled by @wasmer/sdk's clang for wasm32-wasi), for the unit
// tests of src/webCppProviderBridge.mjs: the same exports (konjugateProviderCreate, konjugateProviderDispatch, malloc, free and its
// memory) and some of the same WASI imports, with no libc and no protocol. Instead of a protobuf message, a request is a word the
// provider acts on, and its answer is text:
//
//   "live"            how many blocks are allocated now (the request's and its length's, while the bridge waits: 2 if nothing leaks)
//   "log:<text>"      writes <text> to standard output (fd_write, fd 1), answers "logged"
//   "err:<text>"      writes <text> to standard error (fd 2), answers "logged"
//   "grow:<text>"     grows its memory by 4 pages first (a new ArrayBuffer behind it), then as "log:"
//   "time"            the clock's nanoseconds (clock_time_get), as 8 bytes, little-endian
//   "random"          16 random bytes (random_get)
//   "exit"            calls proc_exit(3), which the bridge must not let pass as a normal exit
//   anything else     "echo:" followed by the request
//
// Built with -DFAIL_CREATE, konjugateProviderCreate answers a failure ("create failed") instead of nothing.
//
// The test builds both itself, with the Emscripten SDK's clang (npm run setup:web), into out/testFixtures/cppProvider, and builds
// them again whenever this file is newer; nothing built from it is kept in the repository.

typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef unsigned long size_t;

#define WASI(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(#name)))
WASI(fd_write) int fd_write(int fd, const void* iovs, int iovsLength, int* written);
WASI(clock_time_get) int clock_time_get(int id, uint64_t precision, uint64_t* time);
WASI(random_get) int random_get(uint8_t* buffer, int length);
WASI(proc_exit) void proc_exit(int code);

extern uint8_t __heap_base;
static uint8_t* top = &__heap_base;
static int live = 0;

void* memcpy(void* to, const void* from, size_t length) {
    uint8_t* out = to;
    const uint8_t* in = from;
    while (length--) *out++ = *in++;
    return to;
}

// A bump allocator: enough for a test, and it counts what is still held.
__attribute__((export_name("malloc"))) void* malloc(size_t size) {
    top = (uint8_t*)(((size_t)top + 7) & ~(size_t)7);
    if ((size_t)(top + size) > __builtin_wasm_memory_size(0) * 65536) __builtin_wasm_memory_grow(0, (size + 65535) / 65536 + 1);
    void* block = top;
    top += size ? size : 1;
    live += 1;
    return block;
}

__attribute__((export_name("free"))) void free(void* block) {
    if (block) live -= 1;
}

static uint8_t* answer(const void* bytes, int length, int* outLength) {
    uint8_t* buffer = malloc(length);
    memcpy(buffer, bytes, length);
    *outLength = length;
    return buffer;
}

static int startsWith(const uint8_t* bytes, int length, const char* prefix) {
    int index = 0;
    for (; prefix[index]; index += 1) if (index >= length || bytes[index] != (uint8_t)prefix[index]) return 0;
    return 1;
}

static uint8_t* write(int fd, const uint8_t* text, int length, int* outLength) {
    uint32_t iov[2] = { (uint32_t)(size_t)text, (uint32_t)length };
    int written = 0;
    fd_write(fd, iov, 1, &written);
    return written == length ? answer("logged", 6, outLength) : answer("short", 5, outLength);
}

__attribute__((export_name("konjugateProviderCreate"))) uint8_t* konjugateProviderCreate(int* outLength) {
#ifdef FAIL_CREATE
    return answer("create failed", 13, outLength);
#else
    *outLength = 0;
    return 0;
#endif
}

__attribute__((export_name("konjugateProviderDispatch"))) uint8_t* konjugateProviderDispatch(const uint8_t* request, int length, int* outLength) {
    if (length == 4 && startsWith(request, length, "live")) {
        uint8_t digit = (uint8_t)('0' + live);
        return answer(&digit, 1, outLength);
    }
    if (startsWith(request, length, "log:")) return write(1, request + 4, length - 4, outLength);
    if (startsWith(request, length, "err:")) return write(2, request + 4, length - 4, outLength);
    if (startsWith(request, length, "grow:")) {
        __builtin_wasm_memory_grow(0, 4);
        return write(1, request + 5, length - 5, outLength);
    }
    if (length == 4 && startsWith(request, length, "time")) {
        uint64_t now = 0;
        clock_time_get(0, 1, &now);
        return answer(&now, 8, outLength);
    }
    if (length == 6 && startsWith(request, length, "random")) {
        uint8_t bytes[16];
        random_get(bytes, 16);
        return answer(bytes, 16, outLength);
    }
    if (length == 4 && startsWith(request, length, "exit")) proc_exit(3);
    uint8_t* buffer = malloc(length + 5);
    memcpy(buffer, "echo:", 5);
    memcpy(buffer + 5, request, length);
    *outLength = length + 5;
    return buffer;
}
