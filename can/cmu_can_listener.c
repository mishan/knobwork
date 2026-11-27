/* SPDX-License-Identifier: MIT
 * Receive-only Mazda CMU VIM CAN collector.
 *
 * This program deliberately has no VIM transmit API dependency.  It registers
 * a callback with the stock VIM service and writes the same public and private
 * gateway frames consumed by the factory CAN test plug-in.
 */

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define VIM_STATUS_OK 100
#define VIM_CLIENT_API_ID UINT32_C(0x80000069)
#define VIM_PUBLIC_FIRST UINT32_C(0x100)
#define VIM_PUBLIC_LAST UINT32_C(0x17f)
#define VIM_PRIVATE_FIRST UINT32_C(0x180)
#define VIM_PRIVATE_LAST UINT32_C(0x1ff)
#define VIM_READY_MESSAGE UINT32_C(0x160)
#define VIM_MAX_CAPTURE_BYTES UINT32_C(64)

typedef uint64_t vim_api_handle_t;

typedef struct {
    uint32_t id;
    uint32_t length;
    const uint8_t *data;
} vim_message_t;

typedef void (*vim_event_callback_t)(
    vim_api_handle_t client,
    vim_api_handle_t server,
    const vim_message_t *message
);

typedef struct {
    vim_event_callback_t event;
} vim_callbacks_t;

#ifndef CMU_CAN_FAKE_VIM
extern vim_api_handle_t IPCAPI_MakeApiHandle(uint32_t api_id, uint32_t instance);
extern int VIMC_Open(vim_api_handle_t client, vim_api_handle_t *server);
extern int VIMC_Close(vim_api_handle_t client, vim_api_handle_t server);
extern int VIMC_AddClient(
    vim_api_handle_t client,
    vim_api_handle_t server,
    const vim_callbacks_t *callbacks
);
extern int VIMC_DeleteClient(vim_api_handle_t client, vim_api_handle_t server);
#endif

static unsigned long sequence_number;
#ifndef CMU_CAN_FAKE_VIM
static volatile sig_atomic_t stop_requested;
#endif

static size_t append_text(char *buffer, size_t used, size_t capacity, const char *text)
{
    size_t length = strlen(text);
    if (used > capacity || length > capacity - used) {
        return capacity + 1;
    }
    memcpy(buffer + used, text, length);
    return used + length;
}

static size_t append_uint(
    char *buffer,
    size_t used,
    size_t capacity,
    unsigned long value
)
{
    char digits[24];
    size_t count = 0;

    do {
        digits[count++] = (char)('0' + (value % 10));
        value /= 10;
    } while (value != 0 && count < sizeof(digits));

    if (used > capacity || count > capacity - used) {
        return capacity + 1;
    }
    while (count > 0) {
        buffer[used++] = digits[--count];
    }
    return used;
}

static size_t append_hex_byte(
    char *buffer,
    size_t used,
    size_t capacity,
    uint8_t value
)
{
    static const char digits[] = "0123456789ABCDEF";
    if (used > capacity || capacity - used < 2) {
        return capacity + 1;
    }
    buffer[used++] = digits[(value >> 4) & 0x0f];
    buffer[used++] = digits[value & 0x0f];
    return used;
}

static size_t append_hex_id(
    char *buffer,
    size_t used,
    size_t capacity,
    uint16_t value
)
{
    static const char digits[] = "0123456789ABCDEF";
    int shift;
    if (used > capacity || capacity - used < 3) {
        return capacity + 1;
    }
    for (shift = 8; shift >= 0; shift -= 4) {
        buffer[used++] = digits[(value >> shift) & 0x0f];
    }
    return used;
}

static int write_record(
    const char *channel,
    unsigned int port,
    uint16_t id,
    uint32_t length,
    const uint8_t *data
)
{
    char record[512];
    size_t used = 0;
    uint32_t index;
    size_t offset = 0;
    unsigned long sequence = __sync_add_and_fetch(&sequence_number, 1);

    used = append_text(record, used, sizeof(record),
        "{\"schema\":\"mazda-cmu-vim-can-v1\",\"sequence\":");
    used = append_uint(record, used, sizeof(record), sequence);
    used = append_text(record, used, sizeof(record), ",\"channel\":\"");
    used = append_text(record, used, sizeof(record), channel);
    used = append_text(record, used, sizeof(record), "\",\"port\":");
    used = append_uint(record, used, sizeof(record), port);
    used = append_text(record, used, sizeof(record), ",\"id\":");
    used = append_uint(record, used, sizeof(record), id);
    used = append_text(record, used, sizeof(record), ",\"idHex\":\"0x");
    used = append_hex_id(record, used, sizeof(record), id);
    used = append_text(record, used, sizeof(record), "\",\"length\":");
    used = append_uint(record, used, sizeof(record), length);
    used = append_text(record, used, sizeof(record), ",\"data\":\"");
    for (index = 0; index < length; index += 1) {
        used = append_hex_byte(record, used, sizeof(record), data[index]);
    }
    used = append_text(record, used, sizeof(record), "\"}\n");
    if (used > sizeof(record)) {
        return -1;
    }

    while (offset < used) {
        ssize_t written = write(STDOUT_FILENO, record + offset, used - offset);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written <= 0) {
            return -1;
        }
        offset += (size_t)written;
    }
    return 0;
}

static void receive_vim_event(
    vim_api_handle_t client,
    vim_api_handle_t server,
    const vim_message_t *message
)
{
    const char *channel;
    unsigned int port;

    (void)client;
    (void)server;
    if (message == NULL || message->data == NULL
            || message->length > VIM_MAX_CAPTURE_BYTES
            || message->id == VIM_READY_MESSAGE) {
        return;
    }

    if (message->id >= VIM_PUBLIC_FIRST && message->id <= VIM_PUBLIC_LAST) {
        channel = "public";
        port = 1;
    } else if (message->id >= VIM_PRIVATE_FIRST
            && message->id <= VIM_PRIVATE_LAST) {
        channel = "private";
        port = 0;
    } else {
        return;
    }

    (void)write_record(
        channel,
        port,
        (uint16_t)message->id,
        message->length,
        message->data
    );
}

#ifdef CMU_CAN_FAKE_VIM
static int run_self_test(void)
{
    static const uint8_t public_data[] = { 0x11, 0x22, 0x33 };
    static const uint8_t private_data[] = {
        0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04
    };
    static const uint8_t ready_data[] = { 1 };
    const vim_message_t messages[] = {
        { UINT32_C(0x123), sizeof(public_data), public_data },
        { VIM_READY_MESSAGE, sizeof(ready_data), ready_data },
        { UINT32_C(0x1ab), sizeof(private_data), private_data }
    };
    size_t index;

    for (index = 0; index < sizeof(messages) / sizeof(messages[0]); index += 1) {
        receive_vim_event(0, 0, &messages[index]);
    }
    return 0;
}
#else
static void request_stop(int signal_number)
{
    (void)signal_number;
    stop_requested = 1;
}
#endif

int main(int argc, char **argv)
{
#ifdef CMU_CAN_FAKE_VIM
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
        return run_self_test();
    }
    fprintf(stderr, "fake build only supports --self-test\n");
    return 2;
#else
    vim_api_handle_t client;
    vim_api_handle_t server = 0;
    const vim_callbacks_t callbacks = { receive_vim_event };
    int status;

    (void)argc;
    (void)argv;
    signal(SIGINT, request_stop);
    signal(SIGTERM, request_stop);

    client = IPCAPI_MakeApiHandle(VIM_CLIENT_API_ID, 0);
    status = VIMC_Open(client, &server);
    if (status != VIM_STATUS_OK) {
        fprintf(stderr, "cmu-can-listener: VIMC_Open failed: %d\n", status);
        return 1;
    }
    status = VIMC_AddClient(client, server, &callbacks);
    if (status != VIM_STATUS_OK) {
        fprintf(stderr, "cmu-can-listener: VIMC_AddClient failed: %d\n", status);
        (void)VIMC_Close(client, server);
        return 1;
    }

    fprintf(stderr,
        "cmu-can-listener: receive-only VIM capture active; press Ctrl-C to stop\n");
    while (!stop_requested) {
        pause();
    }

    (void)VIMC_DeleteClient(client, server);
    (void)VIMC_Close(client, server);
    return 0;
#endif
}
