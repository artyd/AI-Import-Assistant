import type { UktzedEntry } from './index.js';

/**
 * Оверлей синонімів до УКТЗЕД-словника (не змінює вилучену базу).
 * ВАЖЛИВО: усі коди тут — це ті ж коди, що вже є в базі; ми лише розширюємо
 * розпізнавання назв (укр/рос/англ/торгові форми). Нових/непевних кодів НЕ додаємо,
 * щоб не знижувати точність.
 */
export const UKTZED_CODE_DB_EXTRA: UktzedEntry[] = [
  // ── Вітаміни (2936) — переважно бракувало англ. хім. назв і форм ──
  { keys: ['ascorbic acid', 'ascorbate', 'sodium ascorbate', 'аскорбат натрію', 'вит с', 'l-ascorbic acid'], code: '2936270000', name: 'Вітамін C' },
  { keys: ['vitamin d3', 'vit d3', 'colecalciferol'], code: '2936299000', name: 'Вітамін D3' },
  { keys: ['vitamin b1', 'thiamine hcl', 'thiamine mononitrate', 'тіаміну гідрохлорид', 'тіаміну мононітрат'], code: '2936210000', name: 'Вітамін B1' },
  { keys: ['vitamin b2', 'riboflavin phosphate'], code: '2936220000', name: 'Вітамін B2' },
  { keys: ['vitamin b6', 'pyridoxine hcl', 'піридоксину гідрохлорид'], code: '2936240000', name: 'Вітамін B6' },
  { keys: ['vitamin b12', 'cobalamin', 'кобаламін'], code: '2936291000', name: 'Вітамін B12' },
  { keys: ['vitamin a', 'retinol', 'retinyl acetate', 'ретинол пальмітат', 'retinyl palmitate'], code: '2936100000', name: 'Вітамін A' },
  { keys: ['vitamin e', 'tocopheryl acetate', 'alpha-tocopherol', 'токоферол ацетат', 'токоферолу ацетат'], code: '2936280000', name: 'Вітамін E' },
  { keys: ['vitamin b5', 'calcium pantothenate', 'кальцію пантотенат', 'пантотенат кальцію', 'd-calcium pantothenate'], code: '2936500000', name: 'Пантотенат кальцію (B5)' },
  { keys: ['vitamin b3', 'niacinamide', 'nicotinic acid', 'нікотинова кислота', 'нікотинамід'], code: '2936230000', name: 'Вітамін B3' },
  { keys: ['vitamin k3', 'menadione sodium bisulfite', 'менадіон натрію бісульфіт'], code: '2936290000', name: 'Вітамін K3' },
  { keys: ['vitamin b9', 'folacin', 'фолацин'], code: '2936290000', name: 'Фолієва кислота (B9)' },
  { keys: ['vitamin h', 'd-biotin', 'д-біотин'], code: '2936290000', name: 'Біотин (B7/H)' },

  // ── Кормові/харчові амінокислоти (ядро вантажу) — HS 2922/2930 ──
  { keys: ['l-lysine', 'lysine', 'lysine hcl', 'lysine sulfate', 'l-лізин', 'лізин', 'лізин сульфат', 'лізин гідрохлорид', 'l-лизин', 'лизин', 'лизин сульфат', 'лизин гидрохлорид'], code: '2922410000', name: 'L-Лізин' },
  { keys: ['dl-methionine', 'l-methionine', 'methionine', 'dl-метіонін', 'метіонін', 'dl-метионин', 'метионин'], code: '2930400000', name: 'DL-Метіонін' },
  { keys: ['l-threonine', 'threonine', 'l-треонін', 'треонін', 'треонин'], code: '2922500000', name: 'L-Треонін' },
  { keys: ['l-tryptophan', 'tryptophan', 'l-триптофан', 'триптофан'], code: '2922490000', name: 'L-Триптофан' },
  { keys: ['l-valine', 'valine', 'l-валін', 'валін', 'валин'], code: '2922490000', name: 'L-Валін' },
  { keys: ['l-leucine', 'leucine', 'l-лейцин', 'лейцин'], code: '2922490000', name: 'L-Лейцин' },
  { keys: ['l-isoleucine', 'isoleucine', 'l-ізолейцин', 'ізолейцин', 'изолейцин'], code: '2922490000', name: 'L-Ізолейцин' },
  { keys: ['l-glutamine', 'glutamine', 'l-глутамін', 'глутамін', 'глутамин'], code: '2922490000', name: 'L-Глутамін' },
  { keys: ['glycine', 'гліцин', 'глицин'], code: '2922490000', name: 'Гліцин' },
  { keys: ['glutamic acid', 'monosodium glutamate', 'msg', 'глутамінова кислота', 'глутамат натрію', 'глутамат', 'глутаминовая кислота'], code: '2922420000', name: 'Глутамінова кислота / MSG' },

  // ── Часті АФІ, яких НЕ було в базі (парацетамол/метронідазол вже є з точнішими кодами) ──
  { keys: ['caffeine', 'кофеїн', 'кофеин'], code: '2939300000', name: 'Кофеїн' },
  { keys: ['ibuprofen', 'ібупрофен', 'ибупрофен'], code: '2916390000', name: 'Ібупрофен' },
  { keys: ['metformin', 'метформін', 'метформин'], code: '2925290000', name: 'Метформін' },
  { keys: ['omeprazole', 'омепразол'], code: '2933990000', name: 'Омепразол' },
];
