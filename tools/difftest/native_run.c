/* native_run.c —— 差分测试的本机执行端：把同一段机器码在本机 CPU 上执行，
 * 捕获最终寄存器/标志/内存哈希。测试代码必须以 int3 结尾。 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <ucontext.h>

extern void run_stub(void *state);

static sigjmp_buf jb;
static volatile int hit_sig;
static uint64_t out_regs[18];

static uint64_t fnv(uint64_t h, uint64_t v)
{
    int i;
    for (i = 0; i < 8; i++)
        h = (h ^ ((v >> (i * 8)) & 0xff)) * 0x100000001b3ULL;
    return h;
}

static void handler(int sig, siginfo_t *si, void *uc_)
{
    ucontext_t *uc = (ucontext_t *)uc_;
    greg_t *g = uc->uc_mcontext.gregs;
    out_regs[0] = (uint64_t)g[REG_RAX];
    out_regs[1] = (uint64_t)g[REG_RBX];
    out_regs[2] = (uint64_t)g[REG_RCX];
    out_regs[3] = (uint64_t)g[REG_RDX];
    out_regs[4] = (uint64_t)g[REG_RSI];
    out_regs[5] = (uint64_t)g[REG_RDI];
    out_regs[6] = (uint64_t)g[REG_RBP];
    out_regs[7] = (uint64_t)g[REG_RSP];
    out_regs[8] = (uint64_t)g[REG_R8];
    out_regs[9] = (uint64_t)g[REG_R9];
    out_regs[10] = (uint64_t)g[REG_R10];
    out_regs[11] = (uint64_t)g[REG_R11];
    out_regs[12] = (uint64_t)g[REG_R12];
    out_regs[13] = (uint64_t)g[REG_R13];
    out_regs[14] = (uint64_t)g[REG_R14];
    out_regs[15] = (uint64_t)g[REG_R15];
    out_regs[16] = (uint64_t)g[REG_RIP];
    out_regs[17] = (uint64_t)g[REG_EFL];
    hit_sig = sig;
    siglongjmp(jb, 1);
}

int main(int argc, char **argv)
{
    FILE *f;
    uint8_t hdr[160];
    uint8_t code[4096];
    uint64_t state[18];
    int n = 0, i = 0;
    uint64_t h = 0xcbf29ce484222325ULL;
    struct sigaction sa;

    if (argc < 2) { printf("usage: %s blob\n", argv[0]); return 2; }
    f = fopen(argv[1], "rb");
    if (!f) { perror("open"); return 2; }
    if (fread(hdr, 1, 160, f) != 160) { printf("short hdr\n"); return 2; }
    n = (int)fread(code, 1, sizeof(code), f);
    fclose(f);
    memcpy(state, hdr, sizeof(state));

    if (mmap((void *)0x100000, 0x10000, PROT_READ | PROT_WRITE | PROT_EXEC,
             MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED) {
        perror("mmap code"); return 2;
    }
    if (mmap((void *)0x200000, 0x10000, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED) {
        perror("mmap data"); return 2;
    }
    if (mmap((void *)0x2F0000, 0x40000, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED) {
        perror("mmap stack"); return 2;
    }
    memcpy((void *)0x100000, code, (size_t)n);
    for (i = 0; i < 4096; i++)
        ((uint8_t *)0x200000)[i] = (uint8_t)((i * 37 + 11) & 0xff);

    {
        /* glibc 2.34+ 把 SIGSTKSZ 定义成 sysconf() 调用，不是常量，
         * 不能做数组长度；这里固定 64 KiB（远大于 4×SIGSTKSZ）。 */
        static char altstack[65536];
        stack_t ss;
        ss.ss_sp = altstack;
        ss.ss_size = sizeof(altstack);
        ss.ss_flags = 0;
        sigaltstack(&ss, NULL);
    }
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = handler;
    sa.sa_flags = SA_SIGINFO | SA_NODEFER | SA_ONSTACK;
    sigaction(SIGTRAP, &sa, 0);
    sigaction(SIGSEGV, &sa, 0);
    sigaction(SIGFPE, &sa, 0);
    sigaction(SIGILL, &sa, 0);
    sigaction(SIGBUS, &sa, 0);
    sigaction(SIGABRT, &sa, 0);

    if (sigsetjmp(jb, 1) == 0) {
        run_stub(state);
        /* 正常不应到这里（代码以 int3 结尾） */
        hit_sig = 0;
    }
    for (i = 0; i < 4096; i++)
        h = fnv(h, ((uint8_t *)0x200000)[i]);
    printf("RES");
    for (i = 0; i < 16; i++)
        printf(" %llx", (unsigned long long)out_regs[i]);
    printf(" %llx %llx %llx %d\n",
           (unsigned long long)out_regs[16], (unsigned long long)out_regs[17],
           (unsigned long long)h, hit_sig);
    return 0;
}
