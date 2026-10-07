/**
 * Logistics gazetteer — the hub's built-in reference atlas of sea ports
 * (UN/LOCODE), cargo airports (IATA), Ukrainian border crossings and inland
 * hubs. Used to (1) geocode tracking-event locations without a network call and
 * (2) seed the `ports` table the map draws (Phase 2).
 *
 * Coordinates are WGS84 decimal degrees at ~0.01° precision (terminal/airport
 * level — enough for a map marker; not for navigation).
 */

export type PlaceKind = 'sea' | 'air' | 'customs' | 'inland';

export interface Place {
  code: string;
  name: string;
  nameEn: string;
  country: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Extra spellings a carrier page may use (EN/translit/old names). */
  aliases?: string[];
}

type Row = [string, string, string, string, number, number, PlaceKind, string[]?];

const ROWS: Row[] = [
  // ── Sea ports: China / East Asia ───────────────────────────────────────────
  ['CNSHA', 'Шанхай', 'Shanghai', 'CN', 31.23, 121.47, 'sea', ['Yangshan']],
  ['CNNGB', 'Нінбо', 'Ningbo', 'CN', 29.93, 121.85, 'sea', ['Ningbo-Zhoushan', 'Beilun']],
  ['CNSZX', 'Шеньчжень', 'Shenzhen', 'CN', 22.48, 113.88, 'sea', ['Shekou', 'Chiwan']],
  ['CNYTN', 'Яньтянь', 'Yantian', 'CN', 22.56, 114.28, 'sea'],
  ['CNCAN', 'Гуанчжоу (Наньша)', 'Guangzhou', 'CN', 22.75, 113.62, 'sea', ['Nansha']],
  ['CNTAO', 'Циндао', 'Qingdao', 'CN', 36.07, 120.32, 'sea'],
  ['CNTXG', 'Тяньцзінь (Сінган)', 'Tianjin', 'CN', 38.98, 117.75, 'sea', ['Xingang', 'Tianjin Xingang']],
  ['CNXMN', 'Сямень', 'Xiamen', 'CN', 24.48, 118.07, 'sea'],
  ['CNDLC', 'Далянь', 'Dalian', 'CN', 38.93, 121.65, 'sea'],
  ['CNLYG', 'Ляньюньган', 'Lianyungang', 'CN', 34.74, 119.45, 'sea'],
  ['HKHKG', 'Гонконг', 'Hong Kong', 'HK', 22.32, 114.17, 'sea'],
  ['TWKHH', 'Гаосюн', 'Kaohsiung', 'TW', 22.61, 120.28, 'sea'],
  ['KRPUS', 'Пусан', 'Busan', 'KR', 35.1, 129.04, 'sea', ['Pusan']],
  ['JPTYO', 'Токіо', 'Tokyo', 'JP', 35.62, 139.78, 'sea'],
  ['JPYOK', 'Йокогама', 'Yokohama', 'JP', 35.45, 139.65, 'sea'],
  // ── South-East / South Asia ────────────────────────────────────────────────
  ['SGSIN', 'Сингапур', 'Singapore', 'SG', 1.26, 103.82, 'sea'],
  ['MYPKG', 'Порт-Кланг', 'Port Klang', 'MY', 3.0, 101.39, 'sea'],
  ['MYTPP', 'Танджунг-Пелепас', 'Tanjung Pelepas', 'MY', 1.36, 103.55, 'sea'],
  ['VNSGN', 'Хошимін', 'Ho Chi Minh City', 'VN', 10.76, 106.79, 'sea', ['Cat Lai', 'Saigon']],
  ['VNHPH', 'Хайфон', 'Haiphong', 'VN', 20.86, 106.68, 'sea'],
  ['THLCH', 'Лаем-Чабанг', 'Laem Chabang', 'TH', 13.08, 100.88, 'sea'],
  ['IDJKT', 'Джакарта', 'Jakarta', 'ID', -6.1, 106.88, 'sea', ['Tanjung Priok']],
  ['INNSA', 'Нава-Шева', 'Nhava Sheva', 'IN', 18.95, 72.95, 'sea', ['JNPT', 'Jawaharlal Nehru', 'Mumbai']],
  ['INMUN', 'Мундра', 'Mundra', 'IN', 22.75, 69.7, 'sea'],
  ['INMAA', 'Ченнаї', 'Chennai', 'IN', 13.1, 80.3, 'sea', ['Madras']],
  ['INHZA', 'Хазіра', 'Hazira', 'IN', 21.1, 72.65, 'sea'],
  ['LKCMB', 'Коломбо', 'Colombo', 'LK', 6.95, 79.84, 'sea'],
  ['PKKHI', 'Карачі', 'Karachi', 'PK', 24.84, 66.98, 'sea'],
  ['BDCGP', 'Читтагонг', 'Chittagong', 'BD', 22.3, 91.8, 'sea', ['Chattogram']],
  // ── Middle East / Red Sea / Suez ───────────────────────────────────────────
  ['AEJEA', 'Джебель-Алі', 'Jebel Ali', 'AE', 25.01, 55.06, 'sea', ['Dubai']],
  ['OMSLL', 'Салала', 'Salalah', 'OM', 16.94, 54.0, 'sea'],
  ['SAJED', 'Джидда', 'Jeddah', 'SA', 21.48, 39.17, 'sea'],
  ['EGSUZ', 'Суец', 'Suez', 'EG', 30.02, 32.55, 'sea'],
  ['EGPSD', 'Порт-Саїд', 'Port Said', 'EG', 31.26, 32.31, 'sea', ['East Port Said']],
  ['EGALY', 'Александрія', 'Alexandria', 'EG', 31.18, 29.87, 'sea'],
  ['ILHFA', 'Хайфа', 'Haifa', 'IL', 32.82, 35.0, 'sea'],
  // ── Turkey / Mediterranean ─────────────────────────────────────────────────
  ['TRAMR', 'Амбарли', 'Ambarli', 'TR', 40.97, 28.68, 'sea', ['Istanbul', 'Ambarlı']],
  ['TRMER', 'Мерсін', 'Mersin', 'TR', 36.79, 34.63, 'sea'],
  ['TRIZM', 'Ізмір', 'Izmir', 'TR', 38.44, 27.14, 'sea', ['Aliaga']],
  ['GRPIR', 'Пірей', 'Piraeus', 'GR', 37.94, 23.64, 'sea'],
  ['ITGOA', 'Генуя', 'Genoa', 'IT', 44.41, 8.92, 'sea', ['Genova']],
  ['ITGIT', 'Джоя-Тауро', 'Gioia Tauro', 'IT', 38.45, 15.9, 'sea'],
  ['ITTRS', 'Трієст', 'Trieste', 'IT', 45.65, 13.77, 'sea'],
  ['SIKOP', 'Копер', 'Koper', 'SI', 45.55, 13.73, 'sea'],
  ['HRRJK', 'Рієка', 'Rijeka', 'HR', 45.33, 14.43, 'sea'],
  ['MTMAR', 'Марсашлокк', 'Marsaxlokk', 'MT', 35.82, 14.54, 'sea', ['Malta Freeport']],
  ['ESVLC', 'Валенсія', 'Valencia', 'ES', 39.44, -0.32, 'sea'],
  ['ESALG', 'Альхесірас', 'Algeciras', 'ES', 36.13, -5.43, 'sea'],
  ['ESBCN', 'Барселона', 'Barcelona', 'ES', 41.35, 2.16, 'sea'],
  ['FRFOS', 'Марсель-Фос', 'Marseille Fos', 'FR', 43.4, 4.88, 'sea', ['Fos-sur-Mer', 'Marseille']],
  ['MAPTM', 'Танжер-Мед', 'Tanger Med', 'MA', 35.88, -5.5, 'sea', ['Tangier']],
  // ── Black Sea / Danube ─────────────────────────────────────────────────────
  ['UAODS', 'Одеса', 'Odesa', 'UA', 46.49, 30.75, 'sea', ['Odessa']],
  ['UAILK', 'Чорноморськ', 'Chornomorsk', 'UA', 46.3, 30.66, 'sea', ['Illichivsk', 'Ilyichevsk']],
  ['UAYUZ', 'Південний', 'Pivdennyi', 'UA', 46.62, 31.02, 'sea', ['Yuzhny', 'Yuzhnyi']],
  ['UAIZM', 'Ізмаїл', 'Izmail', 'UA', 45.33, 28.83, 'sea'],
  ['UARNI', 'Рені', 'Reni', 'UA', 45.45, 28.28, 'sea'],
  ['ROCND', 'Констанца', 'Constanta', 'RO', 44.17, 28.66, 'sea', ['Constanța', 'Constantza']],
  ['ROGLA', 'Галац', 'Galati', 'RO', 45.43, 28.06, 'sea', ['Galați']],
  ['BGVAR', 'Варна', 'Varna', 'BG', 43.19, 27.92, 'sea'],
  ['BGBOJ', 'Бургас', 'Burgas', 'BG', 42.49, 27.48, 'sea'],
  ['GEPTI', 'Поті', 'Poti', 'GE', 42.15, 41.66, 'sea'],
  ['GEBUS', 'Батумі', 'Batumi', 'GE', 41.65, 41.64, 'sea'],
  // ── North Europe / Baltic ──────────────────────────────────────────────────
  ['NLRTM', 'Роттердам', 'Rotterdam', 'NL', 51.95, 4.14, 'sea'],
  ['BEANR', 'Антверпен', 'Antwerp', 'BE', 51.27, 4.33, 'sea', ['Antwerpen']],
  ['DEHAM', 'Гамбург', 'Hamburg', 'DE', 53.53, 9.98, 'sea'],
  ['DEBRV', 'Бремергафен', 'Bremerhaven', 'DE', 53.56, 8.55, 'sea'],
  ['GBFXT', 'Феліксстоу', 'Felixstowe', 'GB', 51.95, 1.32, 'sea'],
  ['GBSOU', 'Саутгемптон', 'Southampton', 'GB', 50.9, -1.4, 'sea'],
  ['FRLEH', 'Гавр', 'Le Havre', 'FR', 49.48, 0.12, 'sea'],
  ['PLGDN', 'Гданськ', 'Gdansk', 'PL', 54.4, 18.68, 'sea', ['Gdańsk', 'DCT Gdansk']],
  ['PLGDY', 'Гдиня', 'Gdynia', 'PL', 54.53, 18.55, 'sea'],
  ['LTKLJ', 'Клайпеда', 'Klaipeda', 'LT', 55.7, 21.12, 'sea', ['Klaipėda']],
  ['LVRIX', 'Рига', 'Riga', 'LV', 56.95, 24.1, 'sea'],
  ['EETLL', 'Таллінн', 'Tallinn', 'EE', 59.45, 24.77, 'sea', ['Muuga']],
  ['DKAAR', 'Орхус', 'Aarhus', 'DK', 56.15, 10.22, 'sea'],
  ['SEGOT', 'Гетеборг', 'Gothenburg', 'SE', 57.7, 11.9, 'sea', ['Göteborg']],
  // ── Africa / Americas ──────────────────────────────────────────────────────
  ['ZADUR', 'Дурбан', 'Durban', 'ZA', -29.87, 31.03, 'sea'],
  ['USNYC', 'Нью-Йорк', 'New York', 'US', 40.67, -74.05, 'sea', ['Newark', 'New York/New Jersey']],
  ['USSAV', 'Саванна', 'Savannah', 'US', 32.08, -81.09, 'sea'],
  ['USLAX', 'Лос-Анджелес', 'Los Angeles', 'US', 33.74, -118.26, 'sea', ['Long Beach']],
  ['BRSSZ', 'Сантус', 'Santos', 'BR', -23.95, -46.3, 'sea'],

  // ── Cargo airports (IATA) ──────────────────────────────────────────────────
  ['PVG', 'Шанхай Пудун', 'Shanghai Pudong', 'CN', 31.14, 121.81, 'air'],
  ['PEK', 'Пекін Шоуду', 'Beijing Capital', 'CN', 40.08, 116.58, 'air', ['Beijing']],
  ['CAN', 'Гуанчжоу Байюнь', 'Guangzhou Baiyun', 'CN', 23.39, 113.3, 'air'],
  ['SZX', 'Шеньчжень Баоань', 'Shenzhen Bao’an', 'CN', 22.64, 113.81, 'air'],
  ['CTU', 'Ченду', 'Chengdu', 'CN', 30.58, 103.95, 'air'],
  ['HKG', 'Гонконг', 'Hong Kong Intl', 'HK', 22.31, 113.92, 'air'],
  ['TPE', 'Тайбей Таоюань', 'Taipei Taoyuan', 'TW', 25.08, 121.23, 'air'],
  ['ICN', 'Сеул Інчхон', 'Seoul Incheon', 'KR', 37.46, 126.44, 'air', ['Incheon']],
  ['NRT', 'Токіо Наріта', 'Tokyo Narita', 'JP', 35.77, 140.39, 'air', ['Narita']],
  ['SIN', 'Сингапур Чангі', 'Singapore Changi', 'SG', 1.36, 103.99, 'air', ['Changi']],
  ['BKK', 'Бангкок', 'Bangkok Suvarnabhumi', 'TH', 13.69, 100.75, 'air'],
  ['DEL', 'Делі', 'Delhi', 'IN', 28.56, 77.1, 'air', ['New Delhi']],
  ['BOM', 'Мумбаї', 'Mumbai', 'IN', 19.09, 72.87, 'air'],
  ['BLR', 'Бенгалуру', 'Bengaluru', 'IN', 13.2, 77.71, 'air', ['Bangalore']],
  ['HYD', 'Хайдарабад', 'Hyderabad', 'IN', 17.24, 78.43, 'air'],
  ['MAA', 'Ченнаї (аеропорт)', 'Chennai Airport', 'IN', 12.99, 80.17, 'air'],
  ['DXB', 'Дубай', 'Dubai Intl', 'AE', 25.25, 55.36, 'air'],
  ['DWC', 'Дубай Аль-Мактум', 'Dubai World Central', 'AE', 24.9, 55.16, 'air', ['Al Maktoum']],
  ['DOH', 'Доха', 'Doha', 'QA', 25.27, 51.61, 'air'],
  ['AUH', 'Абу-Дабі', 'Abu Dhabi', 'AE', 24.43, 54.65, 'air'],
  ['IST', 'Стамбул', 'Istanbul Airport', 'TR', 41.26, 28.74, 'air'],
  ['SAW', 'Стамбул Сабіха Гекчен', 'Istanbul Sabiha Gokcen', 'TR', 40.9, 29.31, 'air'],
  ['TLV', 'Тель-Авів', 'Tel Aviv', 'IL', 32.01, 34.89, 'air'],
  ['CAI', 'Каїр', 'Cairo', 'EG', 30.12, 31.41, 'air'],
  ['ADD', 'Аддіс-Абеба', 'Addis Ababa', 'ET', 8.98, 38.8, 'air'],
  ['NBO', 'Найробі', 'Nairobi', 'KE', -1.32, 36.93, 'air'],
  ['JNB', 'Йоганнесбург', 'Johannesburg', 'ZA', -26.14, 28.24, 'air'],
  ['FRA', 'Франкфурт', 'Frankfurt', 'DE', 50.04, 8.56, 'air'],
  ['LEJ', 'Лейпциг/Галле', 'Leipzig/Halle', 'DE', 51.42, 12.24, 'air', ['Leipzig']],
  ['CGN', 'Кельн/Бонн', 'Cologne Bonn', 'DE', 50.87, 7.14, 'air', ['Cologne', 'Koln']],
  ['MUC', 'Мюнхен', 'Munich', 'DE', 48.35, 11.79, 'air'],
  ['AMS', 'Амстердам Схіпгол', 'Amsterdam Schiphol', 'NL', 52.31, 4.76, 'air', ['Schiphol']],
  ['LGG', 'Льєж', 'Liege', 'BE', 50.64, 5.44, 'air', ['Liège']],
  ['LUX', 'Люксембург', 'Luxembourg', 'LU', 49.63, 6.21, 'air'],
  ['CDG', 'Париж Шарль де Голль', 'Paris CDG', 'FR', 49.01, 2.55, 'air', ['Paris']],
  ['LHR', 'Лондон Гітроу', 'London Heathrow', 'GB', 51.47, -0.45, 'air', ['London']],
  ['MXP', 'Мілан Мальпенса', 'Milan Malpensa', 'IT', 45.63, 8.72, 'air', ['Milan']],
  ['MAD', 'Мадрид', 'Madrid', 'ES', 40.47, -3.56, 'air'],
  ['VIE', 'Відень', 'Vienna', 'AT', 48.11, 16.57, 'air', ['Wien']],
  ['ZRH', 'Цюрих', 'Zurich', 'CH', 47.46, 8.55, 'air'],
  ['CPH', 'Копенгаген', 'Copenhagen', 'DK', 55.62, 12.65, 'air'],
  ['HEL', 'Гельсінкі', 'Helsinki', 'FI', 60.32, 24.96, 'air'],
  ['WAW', 'Варшава Шопен', 'Warsaw Chopin', 'PL', 52.17, 20.97, 'air', ['Warsaw', 'Warszawa']],
  ['KTW', 'Катовіце', 'Katowice', 'PL', 50.47, 19.08, 'air'],
  ['KRK', 'Краків', 'Krakow', 'PL', 50.08, 19.78, 'air', ['Kraków']],
  ['RZE', 'Жешув', 'Rzeszow', 'PL', 50.11, 22.02, 'air', ['Rzeszów', 'Jasionka']],
  ['BUD', 'Будапешт', 'Budapest', 'HU', 47.44, 19.26, 'air'],
  ['PRG', 'Прага', 'Prague', 'CZ', 50.1, 14.26, 'air', ['Praha']],
  ['OTP', 'Бухарест', 'Bucharest', 'RO', 44.57, 26.09, 'air', ['Otopeni']],
  ['KSC', 'Кошице', 'Kosice', 'SK', 48.66, 21.24, 'air', ['Košice']],
  ['VNO', 'Вільнюс', 'Vilnius', 'LT', 54.63, 25.29, 'air'],
  ['RIX', 'Рига (аеропорт)', 'Riga Airport', 'LV', 56.92, 23.97, 'air'],
  ['KIV', 'Кишинів', 'Chisinau', 'MD', 46.93, 28.93, 'air', ['Chișinău']],
  ['KBP', 'Київ Бориспіль', 'Kyiv Boryspil', 'UA', 50.34, 30.89, 'air', ['Boryspil']],
  ['LWO', 'Львів (аеропорт)', 'Lviv Airport', 'UA', 49.81, 23.96, 'air'],
  ['ODS', 'Одеса (аеропорт)', 'Odesa Airport', 'UA', 46.43, 30.68, 'air'],
  ['GYD', 'Баку', 'Baku', 'AZ', 40.47, 50.05, 'air'],
  ['TBS', 'Тбілісі', 'Tbilisi', 'GE', 41.67, 44.95, 'air'],
  ['ALA', 'Алмати', 'Almaty', 'KZ', 43.35, 77.04, 'air'],
  ['TAS', 'Ташкент', 'Tashkent', 'UZ', 41.26, 69.28, 'air'],
  ['JFK', 'Нью-Йорк JFK', 'New York JFK', 'US', 40.64, -73.78, 'air'],
  ['ORD', 'Чикаго О’Гара', 'Chicago O’Hare', 'US', 41.97, -87.9, 'air', ['Chicago']],
  ['ANC', 'Анкоридж', 'Anchorage', 'US', 61.17, -150.0, 'air'],
  ['LAX', 'Лос-Анджелес (аеропорт)', 'Los Angeles Intl', 'US', 33.94, -118.41, 'air'],
  ['MIA', 'Маямі', 'Miami', 'US', 25.79, -80.29, 'air'],
  ['GRU', 'Сан-Паулу', 'Sao Paulo Guarulhos', 'BR', -23.43, -46.47, 'air'],
  ['SYD', 'Сідней', 'Sydney', 'AU', -33.95, 151.18, 'air'],

  // ── Ukrainian border crossings (road / rail customs) ───────────────────────
  ['UAKRK', 'Краковець', 'Krakovets', 'UA', 49.96, 23.17, 'customs', ['Korczowa']],
  ['UAYAG', 'Ягодин', 'Yahodyn', 'UA', 51.24, 23.79, 'customs', ['Dorohusk', 'Jagodyn']],
  ['UASHE', 'Шегині', 'Shehyni', 'UA', 49.8, 22.96, 'customs', ['Medyka']],
  ['UARAV', 'Рава-Руська', 'Rava-Ruska', 'UA', 50.25, 23.62, 'customs', ['Hrebenne']],
  ['UAUST', 'Устилуг', 'Ustyluh', 'UA', 50.86, 24.15, 'customs', ['Zosin']],
  ['UAHRU', 'Грушів', 'Hrushiv', 'UA', 50.07, 23.13, 'customs', ['Budomierz']],
  ['UASML', 'Смільниця', 'Smilnytsia', 'UA', 49.47, 22.66, 'customs', ['Kroscienko']],
  ['UAUZH', 'Ужгород (Вишнє Нємецьке)', 'Uzhhorod', 'UA', 48.61, 22.26, 'customs', ['Vysne Nemecke']],
  ['UACHP', 'Тиса (Чоп)', 'Chop-Tysa', 'UA', 48.4, 22.18, 'customs', ['Zahony', 'Záhony', 'Chop']],
  ['UALUZ', 'Лужанка', 'Luzhanka', 'UA', 48.14, 22.56, 'customs', ['Beregsurany']],
  ['UADYA', 'Дякове', 'Diakove', 'UA', 47.98, 23.08, 'customs', ['Halmeu']],
  ['UAPOR', 'Порубне', 'Porubne', 'UA', 47.99, 26.03, 'customs', ['Siret']],
  ['UAORL', 'Орлівка (пором)', 'Orlivka', 'UA', 45.3, 28.46, 'customs', ['Isaccea']],
  ['UARNC', 'Рені (Джурджулешть)', 'Reni-Giurgiulesti', 'UA', 45.47, 28.25, 'customs', ['Giurgiulesti']],
  ['UAPAL', 'Паланка', 'Palanka', 'UA', 46.41, 30.13, 'customs', ['Maiaki-Udobnoe']],
  ['UAMOG', 'Могилів-Подільський', 'Mohyliv-Podilskyi', 'UA', 48.44, 27.79, 'customs', ['Otaci']],
  ['UAIZO', 'Ізов (залізниця)', 'Izov rail', 'UA', 50.82, 24.0, 'customs', ['Hrubieszow']],

  // ── Ukrainian inland hubs / cities ─────────────────────────────────────────
  ['UAIEV', 'Київ', 'Kyiv', 'UA', 50.45, 30.52, 'inland', ['Kiev']],
  ['UALWO', 'Львів', 'Lviv', 'UA', 49.84, 24.03, 'inland', ['Lvov', 'Lwow']],
  ['UADNK', 'Дніпро', 'Dnipro', 'UA', 48.46, 35.05, 'inland', ['Dnepr']],
  ['UAHRK', 'Харків', 'Kharkiv', 'UA', 49.99, 36.23, 'inland', ['Kharkov']],
  ['UAVIN', 'Вінниця', 'Vinnytsia', 'UA', 49.23, 28.47, 'inland'],
  ['UARWN', 'Рівне', 'Rivne', 'UA', 50.62, 26.25, 'inland'],
  ['UALTK', 'Луцьк', 'Lutsk', 'UA', 50.75, 25.33, 'inland'],
  ['UATNL', 'Тернопіль', 'Ternopil', 'UA', 49.55, 25.59, 'inland'],
  ['UAHMN', 'Хмельницький', 'Khmelnytskyi', 'UA', 49.42, 26.99, 'inland'],
  ['UACWC', 'Чернівці', 'Chernivtsi', 'UA', 48.29, 25.94, 'inland'],
  ['UAPLV', 'Полтава', 'Poltava', 'UA', 49.59, 34.55, 'inland'],
  ['UAZAP', 'Запоріжжя', 'Zaporizhzhia', 'UA', 47.84, 35.14, 'inland'],
  ['UABRO', 'Бровари', 'Brovary', 'UA', 50.51, 30.79, 'inland'],
  ['UABTS', 'Біла Церква', 'Bila Tserkva', 'UA', 49.8, 30.11, 'inland'],
  ['UAZHT', 'Житомир', 'Zhytomyr', 'UA', 50.25, 28.66, 'inland'],
];

export const PLACES: Place[] = ROWS.map(([code, name, nameEn, country, lat, lng, kind, aliases]) => ({
  code,
  name,
  nameEn,
  country,
  lat,
  lng,
  kind,
  ...(aliases ? { aliases } : {}),
}));

const BY_CODE = new Map(PLACES.map((p) => [p.code, p]));

export function placeByCode(code: string | null | undefined): Place | undefined {
  return code ? BY_CODE.get(code.toUpperCase()) : undefined;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAME_INDEX: Array<{ key: string; place: Place }> = (() => {
  const out: Array<{ key: string; place: Place }> = [];
  for (const p of PLACES) {
    for (const n of [p.name, p.nameEn, ...(p.aliases ?? [])]) out.push({ key: fold(n), place: p });
  }
  // Longest names first so "Port Said" wins over "Said", "Shanghai Pudong" over "Shanghai".
  out.sort((a, b) => b.key.length - a.key.length);
  return out;
})();

/**
 * Best-effort offline geocode of a free-text location from a carrier event
 * ("SHANGHAI, CN", "Gdansk DCT terminal", "UAODS", "Київ, відділення №5").
 * Tries a 5-letter UN/LOCODE or 3-letter IATA token first, then a whole-word
 * name/alias match. Returns undefined when nothing matches (caller may fall back
 * to the network geocoder).
 */
export function matchPlace(text: string | null | undefined, prefer?: PlaceKind): Place | undefined {
  if (!text) return undefined;
  const up = text.toUpperCase();
  for (const m of up.matchAll(/\b([A-Z]{5}|[A-Z]{3})\b/g)) {
    const p = BY_CODE.get(m[1]!);
    if (p && (m[1]!.length === 5 || p.kind === 'air')) return p;
  }
  const f = ` ${fold(text).replace(/[^\p{L}\p{N} ]/gu, ' ')} `;
  const hits = NAME_INDEX.filter(({ key }) => f.includes(` ${key} `));
  if (hits.length === 0) return undefined;
  if (prefer) {
    const preferred = hits.find((h) => h.place.kind === prefer);
    if (preferred) return preferred.place;
  }
  return hits[0]!.place;
}
