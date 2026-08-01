/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "projectContainer.hpp"
#include <algorithm>
#include <array>
#include <boost/property_tree/json_parser.hpp>
#include <cctype>
#include <fstream>
#include <iterator>
#include <openssl/evp.h>
#include <sstream>
#include <vector>
#include <zlib.h>

namespace konjugate {
namespace {
constexpr std::size_t fixedHeaderLength = 10;
constexpr std::size_t maximumHeaderLength = 64 * 1024;
constexpr std::size_t maximumOutputLength = 1024ULL * 1024ULL * 1024ULL;
constexpr unsigned char gzipFlag = 1;
constexpr unsigned char encryptedFlag = 2;

struct ParsedContainer {
    std::vector<unsigned char> bytes;
    std::size_t payloadStart = 0;
    unsigned char flags = 0;
    unsigned char version = 0;
    std::string format;
    boost::property_tree::ptree metadata;
};

std::vector<unsigned char> readBytes(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw ContainerError("INPUT_NOT_FOUND", "The project file could not be opened.");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

ParsedContainer parseContainer(const std::filesystem::path& path) {
    ParsedContainer parsed;
    parsed.bytes = readBytes(path);
    if (parsed.bytes.size() < fixedHeaderLength || !std::equal(parsed.bytes.begin(), parsed.bytes.begin() + 4, "KJTF")) {
        throw ContainerError("INVALID_FORMAT", "This is not a Konjugate project file.");
    }
    parsed.format = "kjt";
    parsed.version = parsed.bytes[4];
    if (parsed.version != 1) throw ContainerError("UNSUPPORTED_VERSION", "The Konjugate container version is not supported.");
    parsed.flags = parsed.bytes[5];
    const std::size_t headerLength = (static_cast<std::size_t>(parsed.bytes[6]) << 24) |
        (static_cast<std::size_t>(parsed.bytes[7]) << 16) | (static_cast<std::size_t>(parsed.bytes[8]) << 8) | parsed.bytes[9];
    if (headerLength > maximumHeaderLength || fixedHeaderLength + headerLength > parsed.bytes.size()) {
        throw ContainerError("INVALID_HEADER", "The project header is damaged.");
    }
    try {
        std::istringstream header(std::string(parsed.bytes.begin() + fixedHeaderLength, parsed.bytes.begin() + fixedHeaderLength + headerLength));
        boost::property_tree::read_json(header, parsed.metadata);
    } catch (...) {
        throw ContainerError("INVALID_HEADER", "The project header is damaged.");
    }
    parsed.payloadStart = fixedHeaderLength + headerLength;
    return parsed;
}

std::vector<unsigned char> decodeBase64(const std::string& encoded, std::size_t expectedSize) {
    if (encoded.empty() || encoded.size() % 4) throw ContainerError("INVALID_HEADER", "The encrypted-project metadata is invalid.");
    std::vector<unsigned char> decoded(encoded.size() / 4 * 3);
    const auto size = EVP_DecodeBlock(decoded.data(), reinterpret_cast<const unsigned char*>(encoded.data()), static_cast<int>(encoded.size()));
    if (size < 0) throw ContainerError("INVALID_HEADER", "The encrypted-project metadata is invalid.");
    std::size_t actual = static_cast<std::size_t>(size);
    if (encoded.ends_with("==")) actual -= 2;
    else if (encoded.ends_with("=")) actual -= 1;
    decoded.resize(actual);
    if (decoded.size() != expectedSize) throw ContainerError("INVALID_HEADER", "The encrypted-project metadata has an invalid size.");
    return decoded;
}

std::vector<unsigned char> decrypt(const ParsedContainer& parsed, const std::string& password) {
    if (password.empty()) throw ContainerError("PASSWORD_REQUIRED", "A password is required.");
    if (parsed.metadata.get<std::string>("kdf.name", "") != "scrypt" ||
        parsed.metadata.get<std::string>("cipher.name", "") != "aes-256-gcm") {
        throw ContainerError("UNSUPPORTED_ENCRYPTION", "The encrypted project uses unsupported cryptography.");
    }
    const auto cost = parsed.metadata.get<std::uint64_t>("kdf.cost", 0);
    const auto blockSize = parsed.metadata.get<std::uint64_t>("kdf.blockSize", 0);
    const auto parallelization = parsed.metadata.get<std::uint64_t>("kdf.parallelization", 0);
    if (cost < (1ULL << 14) || cost > (1ULL << 18) || blockSize != 8 || parallelization < 1 || parallelization > 4) {
        throw ContainerError("INVALID_HEADER", "The project contains unsafe key derivation settings.");
    }
    const auto salt = decodeBase64(parsed.metadata.get<std::string>("kdf.salt", ""), 16);
    const auto iv = decodeBase64(parsed.metadata.get<std::string>("cipher.iv", ""), 12);
    const auto tag = decodeBase64(parsed.metadata.get<std::string>("cipher.tag", ""), 16);
    std::array<unsigned char, 32> key{};
    const auto maximumMemory = std::max<std::uint64_t>(256ULL * 1024ULL * 1024ULL, 256ULL * cost * blockSize);
    if (EVP_PBE_scrypt(password.data(), password.size(), salt.data(), salt.size(), cost, blockSize, parallelization, maximumMemory, key.data(), key.size()) != 1) {
        throw ContainerError("DECRYPTION_FAILED", "The password is incorrect or the project has been modified.");
    }
    const auto payloadSize = parsed.bytes.size() - parsed.payloadStart;
    std::vector<unsigned char> plaintext(payloadSize + 16);
    EVP_CIPHER_CTX* context = EVP_CIPHER_CTX_new();
    int written = 0;
    int finalWritten = 0;
    bool success = context && EVP_DecryptInit_ex(context, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_SET_IVLEN, static_cast<int>(iv.size()), nullptr) == 1 &&
        EVP_DecryptInit_ex(context, nullptr, nullptr, key.data(), iv.data()) == 1 &&
        EVP_DecryptUpdate(context, plaintext.data(), &written, parsed.bytes.data() + parsed.payloadStart, static_cast<int>(payloadSize)) == 1 &&
        EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_SET_TAG, static_cast<int>(tag.size()), const_cast<unsigned char*>(tag.data())) == 1 &&
        EVP_DecryptFinal_ex(context, plaintext.data() + written, &finalWritten) == 1;
    EVP_CIPHER_CTX_free(context);
    std::fill(key.begin(), key.end(), 0);
    if (!success) throw ContainerError("DECRYPTION_FAILED", "The password is incorrect or the project has been modified.");
    plaintext.resize(static_cast<std::size_t>(written + finalWritten));
    return plaintext;
}

std::string inflateGzip(const unsigned char* data, std::size_t size) {
    z_stream stream{};
    stream.next_in = const_cast<Bytef*>(data);
    stream.avail_in = static_cast<uInt>(size);
    if (inflateInit2(&stream, 16 + MAX_WBITS) != Z_OK) throw ContainerError("CORRUPT_PAYLOAD", "The gzip decoder could not be initialized.");
    std::string output;
    std::array<char, 64 * 1024> buffer{};
    int status = Z_OK;
    while (status == Z_OK) {
        stream.next_out = reinterpret_cast<Bytef*>(buffer.data());
        stream.avail_out = static_cast<uInt>(buffer.size());
        status = inflate(&stream, Z_NO_FLUSH);
        output.append(buffer.data(), buffer.size() - stream.avail_out);
        if (output.size() > maximumOutputLength) {
            inflateEnd(&stream);
            throw ContainerError("PAYLOAD_TOO_LARGE", "The decoded project exceeds the size limit.");
        }
    }
    inflateEnd(&stream);
    if (status != Z_STREAM_END) throw ContainerError("CORRUPT_PAYLOAD", "The project payload is damaged.");
    return output;
}
}

ContainerError::ContainerError(std::string errorCode, const std::string& message)
    : std::runtime_error(message), code(std::move(errorCode)) {}

ProjectInspection inspectProject(const std::filesystem::path& path) {
    const auto parsed = parseContainer(path);
    return {parsed.format, parsed.version, static_cast<bool>(parsed.flags & encryptedFlag)};
}

ProjectPayload readProject(const std::filesystem::path& path, const std::string& password) {
    const auto parsed = parseContainer(path);
    if (!(parsed.flags & gzipFlag) || parsed.metadata.get<std::string>("compression", "") != "gzip") {
        throw ContainerError("UNSUPPORTED_COMPRESSION", "The project does not use gzip compression.");
    }
    if (parsed.flags & encryptedFlag) {
        const auto compressed = decrypt(parsed, password);
        return {inflateGzip(compressed.data(), compressed.size()), "kjt", parsed.version, true};
    }
    return {inflateGzip(parsed.bytes.data() + parsed.payloadStart, parsed.bytes.size() - parsed.payloadStart), "kjt", parsed.version, false};
}

}
