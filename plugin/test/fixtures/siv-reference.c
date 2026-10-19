/* Test-only RFC5297 oracle: OpenSSL's independently implemented EVP AES-SIV.
 * No AES/CMAC/S2V implementation here; never linked into the plugin.
 * API contract: https://docs.openssl.org/4.0/man3/EVP_EncryptInit/#siv-mode
 * Arguments are SYNTHETIC hex key/AD only; payload/tag+ct uses stdin.
 */
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/provider.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LIMIT (8 * 1024 * 1024 + 16)

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        EVP_CIPHER *mode = EVP_CIPHER_fetch(NULL, "AES-256-SIV", "provider=default");
        if (!mode) return 2;
        printf("%s; AES-256-SIV provider=%s\n", OpenSSL_version(OPENSSL_VERSION), OSSL_PROVIDER_get0_name(EVP_CIPHER_get0_provider(mode)));
        EVP_CIPHER_free(mode);
        return 0;
    }
    if (argc < 3 || argc > 129) return 2;
    int encrypt = strcmp(argv[1], "seal") == 0;
    if (!encrypt && strcmp(argv[1], "open") != 0) return 2;
    long keylen = 0;
    unsigned char *key = OPENSSL_hexstr2buf(argv[2], &keylen);
    const char *name = keylen == 32 ? "AES-128-SIV" : keylen == 48 ? "AES-192-SIV" : keylen == 64 ? "AES-256-SIV" : NULL;
    unsigned char *input = malloc(LIMIT + 1), *output = malloc(LIMIT + 32);
    EVP_CIPHER *mode = name ? EVP_CIPHER_fetch(NULL, name, "provider=default") : NULL;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int success = 0, length = 0, final = 0;
    if (!key || !input || !output || !mode || !ctx) goto done;
    size_t size = fread(input, 1, LIMIT + 1, stdin);
    if (ferror(stdin) || size > LIMIT || (!encrypt && size < 16)) goto done;
    if (!EVP_CipherInit_ex2(ctx, mode, key, NULL, encrypt, NULL)) goto done;
    if (!encrypt && !EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, 16, input)) goto done;
    for (int i = 3; i < argc; i++) {
        long adlen = 0;
        unsigned char *ad = OPENSSL_hexstr2buf(argv[i], &adlen);
        /* OpenSSL's hex parser represents empty input as a valid empty AD. */
        if (argv[i][0] != '\0' && !ad) goto done;
        unsigned char empty = 0;
        int ok = EVP_CipherUpdate(ctx, NULL, &length, ad ? ad : &empty, (int)adlen);
        OPENSSL_free(ad);
        if (!ok) goto done;
    }
    unsigned char *out = encrypt ? output + 16 : output;
    unsigned char *in = encrypt ? input : input + 16;
    size_t payload = encrypt ? size : size - 16;
    if (!EVP_CipherUpdate(ctx, out, &length, in, (int)payload)) goto done;
    if (!EVP_CipherFinal_ex(ctx, out + length, &final)) goto done;
    if ((size_t)(length + final) != payload) goto done;
    if (encrypt && !EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, 16, output)) goto done;
    size_t written = payload + (encrypt ? 16 : 0);
    /* A failed authentication writes ZERO plaintext to stdout. */
    if (fwrite(output, 1, written, stdout) != written) goto done;
    success = 1;
done:
    EVP_CIPHER_CTX_free(ctx);
    EVP_CIPHER_free(mode);
    OPENSSL_clear_free(key, keylen > 0 ? (size_t)keylen : 0);
    if (input) { OPENSSL_cleanse(input, LIMIT + 1); free(input); }
    if (output) { OPENSSL_cleanse(output, LIMIT + 32); free(output); }
    return success ? 0 : 2;
}
