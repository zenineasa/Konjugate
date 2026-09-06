#ifndef fmi3PlatformTypes_h
#define fmi3PlatformTypes_h

#include <stdbool.h>
#include <stdint.h>

/* Standard type definitions for FMI 3.0, per the FMI Standard (fmi-standard.org), reproduced here
   (BSD-2-Clause, matching the standard's own license for its headers) so an imported FMU can be
   driven without an external FMI SDK dependency. Konjugate's FMI 3.0 import scope is Float64
   scalar variables only (see docs/projectSchema.md) -- the integer/string/binary typedefs below
   are declared anyway, matching the standard's own header exactly, even though Konjugate's own
   glue code never uses most of them; a header that silently omitted them would be a subtly wrong
   reproduction of the standard, not a smaller one. */

typedef float    fmi3Float32;
typedef double   fmi3Float64;
typedef int8_t   fmi3Int8;
typedef uint8_t  fmi3UInt8;
typedef int16_t  fmi3Int16;
typedef uint16_t fmi3UInt16;
typedef int32_t  fmi3Int32;
typedef uint32_t fmi3UInt32;
typedef int64_t  fmi3Int64;
typedef uint64_t fmi3UInt64;
typedef bool     fmi3Boolean;
typedef char     fmi3Char;
typedef const fmi3Char* fmi3String;
typedef uint8_t  fmi3Byte;
typedef const fmi3Byte* fmi3Binary;
typedef uint64_t fmi3ValueReference;
typedef void*    fmi3Instance;
typedef void*    fmi3InstanceEnvironment;
typedef void*    fmi3FMUState;

#define fmi3True true
#define fmi3False false

#endif /* fmi3PlatformTypes_h */
