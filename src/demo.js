export function demoDashboard() {
  return {
    generatedAt: new Date().toISOString(),
    topics: [
      {id:'demo-ai', canonical_title:'AI Agent 自动化工具快速增长', category:'AI', current_score:92, breakout_score:95, source_count:6, status:'hot', ai_summary:'开发者正在寻找更低门槛的自动化工作流方案。', opportunities:[{idea:'开发垂直行业 AI Agent 模板或 SaaS 工具'}]},
      {id:'demo-xhs', canonical_title:'小红书新生活方式趋势扩散', category:'消费', current_score:84, breakout_score:88, source_count:4, status:'rising', ai_summary:'内容平台出现跨圈层传播信号。', opportunities:[{idea:'围绕细分兴趣建立内容与商品服务'}]},
      {id:'demo-github', canonical_title:'开源项目 Star 增长异常', category:'科技', current_score:81, breakout_score:90, source_count:5, status:'rising', ai_summary:'开发者社区出现早期爆发迹象。', opportunities:[{idea:'基于热门开源能力开发插件或服务'}]}
    ],
    categories:[{category:'AI',count:3},{category:'科技',count:2},{category:'消费',count:2}],
    sources:[
      {name:'GitHub',kind:'developer',last_success_at:new Date().toISOString(),last_item_count:12},
      {name:'Hacker News',kind:'global',last_success_at:new Date().toISOString(),last_item_count:20},
      {name:'小红书 MCP',kind:'external',last_item_count:0}
    ],
    timeline:Array.from({length:8},(_,i)=>({t:new Date(Date.now()-i*3600000).toISOString(),score:60+i*4,breakout:55+i*5}))
  };
}
