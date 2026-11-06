// 性能/功能验收禁止产生付费任务；只读场景下载仍使用真实资源。
module.exports = async function mockPaid(context) {
  await context.route(/\/(?:warm|generate|edit|edit-image|rerender|assist|report|world\/generate)(?:\?.*)?$/, route => {
    const assist = new URL(route.request().url()).pathname.endsWith('/assist');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(assist
      ? { reply: '在工作室排好运镜后点「导出 MP4」。导出时保持标签页在前台。', mood: 'happy' }
      : { ok: true, warming: true }) });
  });
};
