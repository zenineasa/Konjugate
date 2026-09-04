#ifndef fmi2TypesPlatform_h
#define fmi2TypesPlatform_h

/* Standard type definitions for FMI 2.0, per the FMI Standard (fmi-standard.org), reproduced here
   (BSD-2-Clause, matching the standard's own license for its headers) so a generated FMU can be
   built without an external FMI SDK dependency. Konjugate only ever targets the "default"
   platform (Real == double, Integer == int32_t, etc.) -- there is no reason for a Konjugate-
   exported FMU to use anything else. */

#define fmi2TypesPlatform "default"

typedef double fmi2Real;
typedef int fmi2Integer;
typedef int fmi2Boolean;
typedef const char* fmi2String;
typedef char fmi2Byte;

#define fmi2True 1
#define fmi2False 0

#endif /* fmi2TypesPlatform_h */
