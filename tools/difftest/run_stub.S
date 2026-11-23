/* run_stub.S —— 把测试状态装入寄存器并跳转到被测代码
 * rdi = struct blob 指针；布局：16 个 GPR（rax,rbx,rcx,rdx,rsi,rdi,rbp,rsp,
 * r8..r15）、rip、flags。被测代码必须以 int3 结尾。
 *
 * 跳转技巧：把目标 rip 放到 [目标 rsp - 8]，用 ret 完成跳转，
 * 这样 ret 之后 rsp 正好等于状态里的 rsp。 */
    .text
    .globl run_stub
    .type run_stub,@function
run_stub:
    movq %rdi, %r11
    movq 0x80(%r11), %rax          /* rip */
    movq 0x38(%r11), %rcx          /* 目标 rsp */
    movq %rax, -8(%rcx)
    leaq -8(%rcx), %rax
    movq %rax, 0x38(%r11)          /* 临时把 rsp 槽改成 目标-8 */
    movq 0x88(%r11), %rax          /* flags */
    pushq %rax
    popfq
    movq 0x00(%r11), %rax
    movq 0x08(%r11), %rbx
    movq 0x10(%r11), %rcx
    movq 0x18(%r11), %rdx
    movq 0x20(%r11), %rsi
    movq 0x28(%r11), %rdi
    movq 0x30(%r11), %rbp
    movq 0x40(%r11), %r8
    movq 0x48(%r11), %r9
    movq 0x50(%r11), %r10
    movq 0x60(%r11), %r12
    movq 0x68(%r11), %r13
    movq 0x70(%r11), %r14
    movq 0x78(%r11), %r15
    movq 0x38(%r11), %rsp
    movq 0x58(%r11), %r11
    ret
    .size run_stub,.-run_stub
