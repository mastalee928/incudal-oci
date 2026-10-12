-- 地区目录：产品方案确认的 45 个地区，E2 与 ARM 各持有一份（沿用「地区属于机型分组」的既有模型）。
-- 既有四条是短名，先改成客户看到的完整名，再补齐其余；重复执行安全。
UPDATE host_region_groups SET name = '美国西部（凤凰城）' WHERE name = '凤凰城';
UPDATE host_region_groups SET name = '美国西部（圣何塞）' WHERE name = '圣何塞';
UPDATE host_region_groups SET name = '英国南部（伦敦）'   WHERE name = '伦敦';
UPDATE host_region_groups SET name = '韩国中部（首尔）'   WHERE name = '首尔';

-- 兼容标签列（hosts / host_onboarding_nodes 上的文本分组名）跟随地区 ID 同步
UPDATE hosts h SET region_group = r.name
  FROM host_region_groups r
  WHERE h.region_group_id = r.id AND h.region_group IS DISTINCT FROM r.name;
UPDATE host_onboarding_nodes n SET region_group = r.name
  FROM host_region_groups r
  WHERE n.region_group_id = r.id AND n.region_group IS DISTINCT FROM r.name;

-- 补齐目录。CROSS JOIN 到 E2 / ARM 两个机型分组。country_code 是购买页「洲 → 城市」分组的唯一依据。
INSERT INTO host_region_groups (machine_group_id, name, country_code)
SELECT g.id, v.name, v.country_code
FROM host_machine_groups g
CROSS JOIN (VALUES
  -- 北美地区
  ('美国东部（阿什本）',      'us'),
  ('美国中西部（芝加哥）',    'us'),
  ('美国西部（凤凰城）',      'us'),
  ('美国西部（圣何塞）',      'us'),
  ('加拿大东南部（蒙特利尔）','ca'),
  ('加拿大东南部（多伦多）',  'ca'),
  ('墨西哥中部（克雷塔罗）',  'mx'),
  ('墨西哥东北部（蒙特雷）',  'mx'),
  -- 南美地区
  ('巴西东部（圣保罗）',      'br'),
  ('巴西东南部（维涅杜）',    'br'),
  ('智利中部（圣地亚哥）',    'cl'),
  ('智利西部（瓦尔帕莱索）',  'cl'),
  ('哥伦比亚中部（波哥大）',  'co'),
  -- 欧洲
  ('法国中部（巴黎）',        'fr'),
  ('法国南部（马赛）',        'fr'),
  ('德国中部（法兰克福）',    'de'),
  ('意大利西北部（米兰）',    'it'),
  ('意大利北部（都灵）',      'it'),
  ('荷兰西北部（阿姆斯特丹）','nl'),
  ('塞尔维亚中部（乔万诺瓦茨）','rs'),
  ('西班牙中部（马德里）',    'es'),
  ('西班牙中部 2（马德里）',  'es'),
  ('瑞典中部（斯德哥尔摩）',  'se'),
  ('瑞士北部（苏黎世）',      'ch'),
  ('英国南部（伦敦）',        'gb'),
  ('英国西部（纽波特）',      'gb'),
  -- 中东和非洲地区
  ('以色列中部（耶路撒冷）',  'il'),
  ('摩洛哥西部（卡萨布兰卡）','ma'),
  ('沙特阿拉伯西部（吉达）',  'sa'),
  ('沙特阿拉伯中部（利雅得）','sa'),
  ('南非中部（约翰内斯堡）',  'za'),
  ('阿联酋东部（迪拜）',      'ae'),
  ('阿联酋中部（阿布扎比）',  'ae'),
  -- 亚太地区
  ('澳大利亚东部（悉尼）',    'au'),
  ('澳大利亚东南部（墨尔本）','au'),
  ('印度西部（孟买）',        'in'),
  ('印度南部（海得拉巴）',    'in'),
  ('印度尼西亚北部（巴淡）',  'id'),
  ('日本东部（东京）',        'jp'),
  ('日本中部（大阪）',        'jp'),
  ('马来西亚西部（古来）',    'my'),
  ('新加坡（新加坡）',        'sg'),
  ('新加坡西部（新加坡）',    'sg'),
  ('韩国中部（首尔）',        'kr'),
  ('韩国北部（春川）',        'kr')
) AS v(name, country_code)
WHERE g.name IN ('E2', 'ARM')
ON CONFLICT DO NOTHING;
