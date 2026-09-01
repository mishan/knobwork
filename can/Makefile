ifeq ($(origin CC),default)
CC := arm-linux-gnueabi-gcc
endif
ifeq ($(origin STRIP),default)
STRIP := arm-linux-gnueabi-strip
endif
CMU_ROOT ?=
BUILD_DIR ?= build
TARGET := $(BUILD_DIR)/cmu-can-listener
TARGET_LINK_DIR := $(BUILD_DIR)/target-libs

CFLAGS ?= -Os -std=c99 -Wall -Wextra -Werror -fno-pie
CPPFLAGS += -D_POSIX_C_SOURCE=200809L
LDFLAGS += -no-pie -Wl,-rpath,/jci/lib
LDFLAGS += -Wl,-rpath-link,$(CMU_ROOT)/jci/lib -Wl,-rpath-link,$(CMU_ROOT)/lib
LDLIBS += -L$(TARGET_LINK_DIR) -L$(CMU_ROOT)/jci/lib
LDLIBS += -ljcivim_api -ljcipcapi -ljcipc -ljcicommon -lpthread -lrt

.PHONY: all clean check-receive-only

all: $(TARGET) check-receive-only

$(TARGET): cmu_can_listener.c $(TARGET_LINK_DIR)/.ready
	@test -n "$(CMU_ROOT)" || { echo "Set CMU_ROOT to the extracted v74 rootfs" >&2; exit 2; }
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS)
	$(STRIP) --strip-unneeded $@

# Link against the target's glibc 2.11 ABI instead of the build host's libc.
# The unversioned names are linker inputs only and never enter the payload.
$(TARGET_LINK_DIR)/.ready:
	@test -n "$(CMU_ROOT)" || { echo "Set CMU_ROOT to the extracted v74 rootfs" >&2; exit 2; }
	@test -f "$(CMU_ROOT)/lib/libc.so.6" || { echo "CMU_ROOT has no target libc" >&2; exit 2; }
	@mkdir -p $(TARGET_LINK_DIR)
	@ln -sf "$(CMU_ROOT)/lib/libc.so.6" $(TARGET_LINK_DIR)/libc.so
	@ln -sf "$(CMU_ROOT)/lib/libpthread.so.0" $(TARGET_LINK_DIR)/libpthread.so
	@ln -sf "$(CMU_ROOT)/lib/librt.so.1" $(TARGET_LINK_DIR)/librt.so
	@ln -sf "$(CMU_ROOT)/lib/libgcc_s.so.1" $(TARGET_LINK_DIR)/libgcc_s.so.1
	@touch $@

check-receive-only: $(TARGET)
	@if readelf -Ws $(TARGET) | grep -q VIMC_SendMessage; then \
		echo "unsafe transmit dependency found" >&2; exit 1; \
	fi
	@if readelf -V $(TARGET) | grep -E 'Name: GLIBC_2\.(1[2-9]|[2-9][0-9])' >/dev/null; then \
		echo "payload requires a glibc newer than the CMU target" >&2; exit 1; \
	fi

clean:
	rm -rf $(BUILD_DIR)
