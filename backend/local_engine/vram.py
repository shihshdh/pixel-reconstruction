"""本机引擎的显存管理：让 SHARP 在 8GB 显卡上也能跑，计算结果不变。

SHARP 的输入固定为 1536×1536、FP32。实测（RTX 5070 Ti 笔记本）：权重 2.6GB，推理中真正分配的
显存峰值约 7.0GB，但 PyTorch 的缓存池会预留到约 10.7GB——多出来的是碎片（空着的块不还给显卡）。
显卡一紧张（界面同时在渲染、别的程序占着显存），驱动就把溢出部分挪到系统内存，推理从约 6 秒拖到
一分多钟。两招，都不改变任何一次计算，输出逐位一致（对三张图比对了全部高斯参数的哈希）：

1. 每个大模块跑完后把缓存池里的空块还给显卡（trim）。单用这一招：预留 10.7GB → 8.4GB。
2. 权重按模块“用到才上显卡”（stage）。SHARP 的几个大模块依次执行，不必同时占着显存。权重在内存里
   常驻一份锁页副本（2.6GB），上显卡只是一次 PCIe 拷贝，卸下只是丢掉显卡上那份。

两招一起：分配峰值 7.0GB → 4.4GB，预留峰值 10.7GB → 5.7GB，任务结束后整卡占用 11.9GB → 3.5GB，
推理耗时不变（约 6 秒）。8GB 显卡连同 CUDA 上下文约用 6.2GB；12GB 的卡推理时给界面和别的程序
留出一半显存，不会再被挤到系统内存。所以默认所有显卡都分段载入。
"""

# 依次执行的大模块。名字取自 sharp.cli.predict.create_predictor 建出的模型；
# 版本不同、找不到的名字直接跳过（退回整模型常驻显存），不影响结果。
TRIM_AFTER = (
    "monodepth_model.monodepth_predictor.encoder",
    "monodepth_model.monodepth_predictor.decoder",
    "monodepth_model",
    "feature_model.decoder",
    "feature_model",
    "depth_alignment",
)
STAGES = (
    "monodepth_model.monodepth_predictor.encoder",
    "monodepth_model.monodepth_predictor.decoder",
    "monodepth_model.monodepth_predictor.head",
    "feature_model",
    "depth_alignment",
)


def place(model, torch, total_gb, staged=None):
    """把模型放上显卡。返回实际采用的方式："resident" 或 "staged"。"""
    if staged is None:
        staged = True
    modules = dict(model.named_modules())
    stages = [name for name in STAGES if name in modules] if staged else []

    def inside(name):
        return any(name == s or name.startswith(s + ".") for s in stages)

    for name, tensor in list(model.named_parameters()) + list(model.named_buffers()):
        if not inside(name):
            tensor.data = tensor.data.to("cuda")

    pinned = {}
    for stage in stages:
        for name, tensor in list(modules[stage].named_parameters()) + list(modules[stage].named_buffers()):
            pinned[(stage, name)] = tensor.data.pin_memory()
            tensor.data = pinned[(stage, name)]

    def load(stage):
        for name, tensor in list(modules[stage].named_parameters()) + list(modules[stage].named_buffers()):
            tensor.data = pinned[(stage, name)].to("cuda", non_blocking=True)

    def unload(stage):
        for name, tensor in list(modules[stage].named_parameters()) + list(modules[stage].named_buffers()):
            tensor.data = pinned[(stage, name)]
        torch.cuda.empty_cache()

    for stage in stages:
        modules[stage].register_forward_pre_hook(lambda module, args, stage=stage: load(stage))
        modules[stage].register_forward_hook(lambda module, args, output, stage=stage: unload(stage))
    for name in TRIM_AFTER:
        if name in modules and name not in stages:
            modules[name].register_forward_hook(lambda *args: torch.cuda.empty_cache())
    return "staged" if stages else "resident"
