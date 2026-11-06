/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The main() a person's C++ objective program is linked with (see konjugate/objectiveProgram.hpp): it reads one framed
// ObjectiveRunRequest at a time from stdin, calls objective() with the run, and writes a framed ObjectiveRunResult to stdout, until
// stdin closes. The messages are decoded and encoded by hand (protocol/engineProtocol.proto), so a person's program needs no
// protobuf library to be built.

#include <konjugate/objectiveProgram.hpp>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

bool readExact(char* buffer, std::size_t size) {
    return std::fread(buffer, 1, size, stdin) == size;
}

std::uint64_t readVarint(const std::string& data, std::size_t& offset) {
    std::uint64_t value = 0;
    for (int shift = 0; offset < data.size() && shift < 64; shift += 7) {
        const auto byte = static_cast<unsigned char>(data[offset++]);
        value |= static_cast<std::uint64_t>(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value;
    }
    throw std::runtime_error("An unreadable message from the engine.");
}

double readDouble(const char* bytes) {
    double value;
    std::memcpy(&value, bytes, 8);
    return value;
}

// Calls `field(number, wireType, payload)` for each field of a message; a varint's value is in `varint`.
template <typename Field>
void eachField(const std::string& data, Field field) {
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto key = readVarint(data, offset);
        const auto number = static_cast<int>(key >> 3);
        const auto wireType = static_cast<int>(key & 7);
        if (wireType == 0) {
            const auto varint = readVarint(data, offset);
            field(number, wireType, std::string(), varint);
        } else if (wireType == 1) {
            if (offset + 8 > data.size()) throw std::runtime_error("An unreadable message from the engine.");
            field(number, wireType, data.substr(offset, 8), 0);
            offset += 8;
        } else if (wireType == 2) {
            const auto length = static_cast<std::size_t>(readVarint(data, offset));
            if (offset + length > data.size()) throw std::runtime_error("An unreadable message from the engine.");
            field(number, wireType, data.substr(offset, length), 0);
            offset += length;
        } else if (wireType == 5) {
            offset += 4;
        } else {
            throw std::runtime_error("An unreadable message from the engine.");
        }
    }
}

void appendDoubles(std::vector<double>& values, int wireType, const std::string& payload) {
    if (wireType == 1) values.push_back(readDouble(payload.data()));
    else for (std::size_t offset = 0; offset + 8 <= payload.size(); offset += 8) values.push_back(readDouble(payload.data() + offset));
}

konjugate::Run decodeRun(const std::string& data) {
    konjugate::Run run;
    eachField(data, [&](int number, int wireType, const std::string& payload, std::uint64_t) {
        if (number == 1) appendDoubles(run.times_, wireType, payload);
        else if ((number == 2 || number == 3) && wireType == 2) {
            std::string key;
            std::vector<double> values;
            eachField(payload, [&](int part, int partWire, const std::string& partPayload, std::uint64_t) {
                if (part == 1 && partWire == 2) key = partPayload;
                else if (part == 2) appendDoubles(values, partWire, partPayload);
            });
            if (number == 2) run.series_[key] = std::move(values);
            else run.values_[key] = values.empty() ? 0.0 : values.front();
        }
    });
    return run;
}

void putVarint(std::string& out, std::uint64_t value) {
    do {
        auto byte = static_cast<unsigned char>(value & 0x7f);
        value >>= 7;
        if (value) byte |= 0x80;
        out.push_back(static_cast<char>(byte));
    } while (value);
}

void putDouble(std::string& out, int number, double value) {
    putVarint(out, (static_cast<std::uint64_t>(number) << 3) | 1);
    char bytes[8];
    std::memcpy(bytes, &value, 8);
    out.append(bytes, 8);
}

void putBytes(std::string& out, int number, const std::string& bytes) {
    putVarint(out, (static_cast<std::uint64_t>(number) << 3) | 2);
    putVarint(out, bytes.size());
    out += bytes;
}

void writeFrame(const std::string& payload) {
    const auto size = static_cast<std::uint32_t>(payload.size());
    const unsigned char header[4] = {
        static_cast<unsigned char>((size >> 24) & 0xff), static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff), static_cast<unsigned char>(size & 0xff)
    };
    std::fwrite(header, 1, 4, stdout);
    std::fwrite(payload.data(), 1, payload.size(), stdout);
    std::fflush(stdout);
}

}

int main() {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    while (true) {
        unsigned char header[4];
        if (!readExact(reinterpret_cast<char*>(header), 4)) return 0;
        const auto size = (static_cast<std::uint32_t>(header[0]) << 24) | (static_cast<std::uint32_t>(header[1]) << 16) |
                          (static_cast<std::uint32_t>(header[2]) << 8) | static_cast<std::uint32_t>(header[3]);
        std::string data(size, '\0');
        if (size && !readExact(data.data(), size)) return 0;
        std::string result;
        try {
            const auto run = decodeRun(data);
            const double value = objective(run);
            putVarint(result, (1u << 3) | 0);
            putVarint(result, 1);
            putDouble(result, 3, value);
            for (const auto& [key, reported] : run.reports_) {
                std::string entry;
                putBytes(entry, 1, key);
                putDouble(entry, 2, reported);
                putBytes(result, 4, entry);
            }
        } catch (const std::exception& error) {
            result.clear();
            putBytes(result, 2, error.what());
        } catch (...) {
            result.clear();
            putBytes(result, 2, "The objective threw something that is not an exception.");
        }
        writeFrame(result);
    }
}
