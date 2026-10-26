/**
 * Nifty 500 constituent list.
 *
 * Source: NSE Indices — ind_nifty500list.csv
 * URL: https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv
 * Retrieved: 2026-10-25 (snapshot: data/nifty500/ind_nifty500list-2026-10-25.csv)
 *
 * NSE reviews index composition periodically and makes ad-hoc changes for
 * corporate actions. Re-download the official CSV, replace the snapshot,
 * regenerate this list, and reconcile it against the active Kite master before
 * a production scan.
 *
 * Kite stores non-EQ series with a suffix (HFCL-BE, BIRET-RR). Matching
 * candidates are built by resolveNifty500Candidates(). NSE symbol renames are
 * recorded in NIFTY500_SYMBOL_ALIASES with their circular reference.
 */

export const NIFTY500_SOURCE_URL =
  "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv";
export const NIFTY500_LAST_UPDATED = "2026-10-25";

/** Minimum row count accepted from the official source before it is partial. */
export const NIFTY500_MIN_EXPECTED = 500;

export type Nifty500Series = "EQ" | "BE" | "RR";

export interface Nifty500Constituent {
  symbol: string;
  series: Nifty500Series;
  isin: string;
  companyName: string;
}

/**
 * Non-tradeable placeholder rows present in the official file. They are
 * documented here so a refresh cannot silently add them to the scan universe.
 */
export const NIFTY500_EXCLUDED_PLACEHOLDERS: Record<string, string> = {
  DUMMYHEG:
    "NSE placeholder row (ISIN DUM545A01024, 'Dummy HEG Ltd.'); not a tradeable constituent",
};

/**
 * NSE symbol renames that post-date the index CSV. Key is the symbol in the
 * official file; value is the current NSE/Kite trading symbol.
 */
export const NIFTY500_SYMBOL_ALIASES: Record<string, string> = {
  // NSE circular 143/2026: ICICI Prudential Life renamed ICICI Life Insurance,
  // symbol changed from ICICIPRULI to ICICILIFE effective 2026-10-23.
  ICICIPRULI: "ICICILIFE",
};

// [official NSE symbol, series, ISIN, company name]
const RAW_CONSTITUENTS: Array<[string, Nifty500Series, string, string]> = [
  ["360ONE", "EQ", "INE466L01038", "360 ONE WAM Ltd."],
  ["ABB", "EQ", "INE117A01022", "ABB India Ltd."],
  ["ACC", "EQ", "INE012A01025", "ACC Ltd."],
  ["ACMESOLAR", "EQ", "INE622W01025", "ACME Solar Holdings Ltd."],
  ["AIAENG", "EQ", "INE212H01026", "AIA Engineering Ltd."],
  ["APLAPOLLO", "EQ", "INE702C01027", "APL Apollo Tubes Ltd."],
  ["AUBANK", "EQ", "INE949L01017", "AU Small Finance Bank Ltd."],
  ["AWL", "EQ", "INE699H01024", "AWL Agri Business Ltd."],
  ["AADHARHFC", "EQ", "INE883F01010", "Aadhar Housing Finance Ltd."],
  ["AARTIIND", "EQ", "INE769A01020", "Aarti Industries Ltd."],
  ["AAVAS", "EQ", "INE216P01012", "Aavas Financiers Ltd."],
  ["ABBOTINDIA", "EQ", "INE358A01014", "Abbott India Ltd."],
  ["ACE", "EQ", "INE731H01025", "Action Construction Equipment Ltd."],
  ["ACUTAAS", "EQ", "INE00FF01025", "Acutaas Chemicals Ltd."],
  ["ADANIENSOL", "EQ", "INE931S01010", "Adani Energy Solutions Ltd."],
  ["ADANIENT", "EQ", "INE423A01024", "Adani Enterprises Ltd."],
  ["ADANIGREEN", "EQ", "INE364U01010", "Adani Green Energy Ltd."],
  ["ADANIPORTS", "EQ", "INE742F01042", "Adani Ports and Special Economic Zone Ltd."],
  ["ADANIPOWER", "EQ", "INE814H01029", "Adani Power Ltd."],
  ["ATGL", "EQ", "INE399L01023", "Adani Total Gas Ltd."],
  ["ABCAPITAL", "EQ", "INE674K01013", "Aditya Birla Capital Ltd."],
  ["ABREL", "EQ", "INE055A01016", "Aditya Birla Real Estate Ltd."],
  ["ABSLAMC", "EQ", "INE404A01024", "Aditya Birla Sun Life AMC Ltd."],
  ["CPPLUS", "EQ", "INE819V01029", "Aditya Infotech Ltd."],
  ["AEGISLOG", "EQ", "INE208C01025", "Aegis Logistics Ltd."],
  ["AEGISVOPAK", "EQ", "INE0INX01018", "Aegis Vopak Terminals Ltd."],
  ["AETHER", "EQ", "INE0BWX01014", "Aether Industries Ltd."],
  ["AFCONS", "EQ", "INE101I01011", "Afcons Infrastructure Ltd."],
  ["AFFLE", "EQ", "INE00WC01027", "Affle 3i Ltd."],
  ["AJANTPHARM", "EQ", "INE031B01049", "Ajanta Pharmaceuticals Ltd."],
  ["ALKEM", "EQ", "INE540L01014", "Alkem Laboratories Ltd."],
  ["ABDL", "EQ", "INE552Z01027", "Allied Blenders and Distillers Ltd."],
  ["ARE&M", "EQ", "INE885A01032", "Amara Raja Energy & Mobility Ltd."],
  ["AMBER", "EQ", "INE371P01015", "Amber Enterprises India Ltd."],
  ["AMBUJACEM", "EQ", "INE079A01024", "Ambuja Cements Ltd."],
  ["ANANDRATHI", "EQ", "INE463V01026", "Anand Rathi Wealth Ltd."],
  ["ANANTRAJ", "EQ", "INE242C01024", "Anant Raj Ltd."],
  ["ANGELONE", "EQ", "INE732I01021", "Angel One Ltd."],
  ["ANTHEM", "EQ", "INE0CZ201020", "Anthem Biosciences Ltd."],
  ["ANURAS", "EQ", "INE930P01018", "Anupam Rasayan India Ltd."],
  ["APARINDS", "EQ", "INE372A01015", "Apar Industries Ltd."],
  ["APOLLOHOSP", "EQ", "INE437A01024", "Apollo Hospitals Enterprise Ltd."],
  ["APOLLOTYRE", "EQ", "INE438A01022", "Apollo Tyres Ltd."],
  ["APTUS", "EQ", "INE852O01025", "Aptus Value Housing Finance India Ltd."],
  ["ASAHIINDIA", "EQ", "INE439A01020", "Asahi India Glass Ltd."],
  ["ASHOKLEY", "EQ", "INE208A01029", "Ashok Leyland Ltd."],
  ["ASIANPAINT", "EQ", "INE021A01026", "Asian Paints Ltd."],
  ["ASTERDM", "EQ", "INE914M01019", "Aster DM Quality Care Ltd."],
  ["ASTRAL", "EQ", "INE006I01046", "Astral Ltd."],
  ["ATHERENERG", "EQ", "INE0LEZ01016", "Ather Energy Ltd."],
  ["ATUL", "EQ", "INE100A01010", "Atul Ltd."],
  ["AUROPHARMA", "EQ", "INE406A01037", "Aurobindo Pharma Ltd."],
  ["AIIL", "EQ", "INE206F01022", "Authum Investment & Infrastructure Ltd."],
  ["AVANTIFEED", "EQ", "INE871C01038", "Avanti Feeds Ltd."],
  ["DMART", "EQ", "INE192R01011", "Avenue Supermarts Ltd."],
  ["AXISBANK", "EQ", "INE238A01034", "Axis Bank Ltd."],
  ["AZAD", "EQ", "INE02IJ01035", "Azad Engineering Ltd."],
  ["BEML", "EQ", "INE258A01024", "BEML Ltd."],
  ["BLS", "EQ", "INE153T01027", "BLS International Services Ltd."],
  ["BSE", "EQ", "INE118H01025", "BSE Ltd."],
  ["BAGMANE", "RR", "INE2OVN25015", "Bagmane Prime Office REIT"],
  ["BAJAJ-AUTO", "EQ", "INE917I01010", "Bajaj Auto Ltd."],
  ["BAJFINANCE", "EQ", "INE296A01032", "Bajaj Finance Ltd."],
  ["BAJAJFINSV", "EQ", "INE918I01026", "Bajaj Finserv Ltd."],
  ["BAJAJHLDNG", "EQ", "INE118A01012", "Bajaj Holdings & Investment Ltd."],
  ["BAJAJHFL", "EQ", "INE377Y01014", "Bajaj Housing Finance Ltd."],
  ["BALKRISIND", "EQ", "INE787D01026", "Balkrishna Industries Ltd."],
  ["BALRAMCHIN", "EQ", "INE119A01028", "Balrampur Chini Mills Ltd."],
  ["BANDHANBNK", "EQ", "INE545U01014", "Bandhan Bank Ltd."],
  ["BANKBARODA", "EQ", "INE028A01039", "Bank of Baroda"],
  ["BANKINDIA", "EQ", "INE084A01016", "Bank of India"],
  ["MAHABANK", "EQ", "INE457A01014", "Bank of Maharashtra"],
  ["BATAINDIA", "EQ", "INE176A01028", "Bata India Ltd."],
  ["BELRISE", "EQ", "INE894V01022", "Belrise Industries Ltd."],
  ["BERGEPAINT", "EQ", "INE463A01038", "Berger Paints India Ltd."],
  ["BHARATCOAL", "EQ", "INE05XR01022", "Bharat Coking Coal Ltd."],
  ["BDL", "EQ", "INE171Z01026", "Bharat Dynamics Ltd."],
  ["BEL", "EQ", "INE263A01024", "Bharat Electronics Ltd."],
  ["BHARATFORG", "EQ", "INE465A01025", "Bharat Forge Ltd."],
  ["BHEL", "EQ", "INE257A01026", "Bharat Heavy Electricals Ltd."],
  ["BPCL", "EQ", "INE029A01011", "Bharat Petroleum Corporation Ltd."],
  ["BHARTIARTL", "EQ", "INE397D01024", "Bharti Airtel Ltd."],
  ["BHARTIHEXA", "EQ", "INE343G01021", "Bharti Hexacom Ltd."],
  ["GROWW", "EQ", "INE0HOQ01053", "Billionbrains Garage Ventures Ltd."],
  ["BIOCON", "EQ", "INE376G01013", "Biocon Ltd."],
  ["BSOFT", "EQ", "INE836A01035", "Birlasoft Ltd."],
  ["BBOX", "EQ", "INE676A01027", "Black Box Ltd."],
  ["BLUESTARCO", "EQ", "INE472A01039", "Blue Star Ltd."],
  ["BOSCHLTD", "EQ", "INE323A01026", "Bosch Ltd."],
  ["FIRSTCRY", "EQ", "INE02RE01045", "Brainbees Solutions Ltd."],
  ["BRIGADE", "EQ", "INE791I01019", "Brigade Enterprises Ltd."],
  ["BRITANNIA", "EQ", "INE216A01030", "Britannia Industries Ltd."],
  ["BIRET", "RR", "INE0FDU25010", "Brookfield India Real Estate Trust"],
  ["CCL", "EQ", "INE421D01022", "CCL Products (I) Ltd."],
  ["CESC", "EQ", "INE486A01021", "CESC Ltd."],
  ["CGPOWER", "EQ", "INE067A01029", "CG Power and Industrial Solutions Ltd."],
  ["CIEINDIA", "EQ", "INE536H01010", "CIE Automotive India Ltd."],
  ["CRISIL", "EQ", "INE007A01025", "CRISIL Ltd."],
  ["CANFINHOME", "EQ", "INE477A01020", "Can Fin Homes Ltd."],
  ["CANBK", "EQ", "INE476A01022", "Canara Bank"],
  ["CANHLIFE", "EQ", "INE01TY01017", "Canara HSBC Life Insurance Company Ltd."],
  ["CAPLIPOINT", "EQ", "INE475E01026", "Caplin Point Laboratories Ltd."],
  ["CGCL", "EQ", "INE180C01042", "Capri Global Capital Ltd."],
  ["CARBORUNIV", "EQ", "INE120A01034", "Carborundum Universal Ltd."],
  ["CARTRADE", "EQ", "INE290S01011", "Cartrade Tech Ltd."],
  ["CASTROLIND", "EQ", "INE172A01027", "Castrol India Ltd."],
  ["CEATLTD", "EQ", "INE482A01020", "Ceat Ltd."],
  ["CEMPRO", "EQ", "INE686A01026", "Cemindia Projects Ltd."],
  ["CENTRALBK", "EQ", "INE483A01010", "Central Bank of India"],
  ["CDSL", "EQ", "INE736A01011", "Central Depository Services (India) Ltd."],
  ["CMPDI", "EQ", "INE05HV01027", "Central Mine Planning & Design Institute Ltd."],
  ["CHAMBLFERT", "EQ", "INE085A01013", "Chambal Fertilizers & Chemicals Ltd."],
  ["CHENNPETRO", "EQ", "INE178A01016", "Chennai Petroleum Corporation Ltd."],
  ["CHOICEIN", "EQ", "INE102B01014", "Choice International Ltd."],
  ["CHOLAHLDNG", "EQ", "INE149A01033", "Cholamandalam Financial Holdings Ltd."],
  ["CHOLAFIN", "EQ", "INE121A01024", "Cholamandalam Investment and Finance Company Ltd."],
  ["CIPLA", "EQ", "INE059A01026", "Cipla Ltd."],
  ["CUB", "EQ", "INE491A01021", "City Union Bank Ltd."],
  ["CLEANMAX", "EQ", "INE647U01026", "Clean Max Enviro Energy Solutions Ltd."],
  ["CLEAN", "EQ", "INE227W01023", "Clean Science and Technology Ltd."],
  ["COALINDIA", "EQ", "INE522F01014", "Coal India Ltd."],
  ["COCHINSHIP", "EQ", "INE704P01025", "Cochin Shipyard Ltd."],
  ["COFORGE", "EQ", "INE591G01025", "Coforge Ltd."],
  ["COHANCE", "EQ", "INE03QK01018", "Cohance Lifesciences Ltd."],
  ["COLPAL", "EQ", "INE259A01022", "Colgate Palmolive (India) Ltd."],
  ["CAMS", "EQ", "INE596I01020", "Computer Age Management Services Ltd."],
  ["CONCORDBIO", "EQ", "INE338H01029", "Concord Biotech Ltd."],
  ["CONCOR", "EQ", "INE111A01025", "Container Corporation of India Ltd."],
  ["COROMANDEL", "EQ", "INE169A01031", "Coromandel International Ltd."],
  ["CRAFTSMAN", "EQ", "INE00LO01017", "Craftsman Automation Ltd."],
  ["CREDITACC", "EQ", "INE741K01010", "CreditAccess Grameen Ltd."],
  ["CROMPTON", "EQ", "INE299U01018", "Crompton Greaves Consumer Electricals Ltd."],
  ["CUMMINSIND", "EQ", "INE298A01020", "Cummins India Ltd."],
  ["CUPID", "EQ", "INE509F01029", "Cupid Ltd."],
  ["CYIENT", "EQ", "INE136B01020", "Cyient Ltd."],
  ["DLF", "EQ", "INE271C01023", "DLF Ltd."],
  ["DOMS", "EQ", "INE321T01012", "DOMS Industries Ltd."],
  ["DABUR", "EQ", "INE016A01026", "Dabur India Ltd."],
  ["DALBHARAT", "EQ", "INE00R701025", "Dalmia Bharat Ltd."],
  ["DATAPATTNS", "EQ", "INE0IX101010", "Data Patterns (India) Ltd."],
  ["DEEPAKFERT", "EQ", "INE501A01019", "Deepak Fertilisers & Petrochemicals Corp. Ltd."],
  ["DEEPAKNTR", "EQ", "INE288B01029", "Deepak Nitrite Ltd."],
  ["DELHIVERY", "EQ", "INE148O01028", "Delhivery Ltd."],
  ["DEVYANI", "EQ", "INE872J01023", "Devyani International Ltd."],
  ["DIVISLAB", "EQ", "INE361B01024", "Divi's Laboratories Ltd."],
  ["DIXON", "EQ", "INE935N01020", "Dixon Technologies (India) Ltd."],
  ["LALPATHLAB", "EQ", "INE600L01024", "Dr. Lal Path Labs Ltd."],
  ["DRREDDY", "EQ", "INE089A01031", "Dr. Reddy's Laboratories Ltd."],
  ["EIDPARRY", "EQ", "INE126A01031", "E.I.D. Parry (India) Ltd."],
  ["EIHOTEL", "EQ", "INE230A01023", "EIH Ltd."],
  ["EMBASSY", "RR", "INE041025011", "EMBASSY OFFICE PARKS REIT"],
  ["EICHERMOT", "EQ", "INE066A01021", "Eicher Motors Ltd."],
  ["ELECON", "EQ", "INE205B01031", "Elecon Engineering Co. Ltd."],
  ["ELGIEQUIP", "EQ", "INE285A01027", "Elgi Equipments Ltd."],
  ["EMAMILTD", "EQ", "INE548C01032", "Emami Ltd."],
  ["EMCURE", "EQ", "INE168P01015", "Emcure Pharmaceuticals Ltd."],
  ["EMMVEE", "EQ", "INE1C6T01020", "Emmvee Photovoltaic Power Ltd."],
  ["ENDURANCE", "EQ", "INE913H01037", "Endurance Technologies Ltd."],
  ["ENGINERSIN", "EQ", "INE510A01028", "Engineers India Ltd."],
  ["ESCORTS", "EQ", "INE042A01014", "Escorts Kubota Ltd."],
  ["ETERNAL", "EQ", "INE758T01015", "Eternal Ltd."],
  ["EXIDEIND", "EQ", "INE302A01020", "Exide Industries Ltd."],
  ["NYKAA", "EQ", "INE388Y01029", "FSN E-Commerce Ventures Ltd."],
  ["FEDERALBNK", "EQ", "INE171A01029", "Federal Bank Ltd."],
  ["FACT", "EQ", "INE188A01015", "Fertilisers and Chemicals Travancore Ltd."],
  ["FINCABLES", "EQ", "INE235A01022", "Finolex Cables Ltd."],
  ["FSL", "EQ", "INE684F01012", "Firstsource Solutions Ltd."],
  ["FIVESTAR", "EQ", "INE128S01021", "Five-Star Business Finance Ltd."],
  ["FORCEMOT", "EQ", "INE451A01017", "Force Motors Ltd."],
  ["FORTIS", "EQ", "INE061F01013", "Fortis Healthcare Ltd."],
  ["FRACTAL", "EQ", "INE212S01015", "Fractal Analytics Ltd."],
  ["GAIL", "EQ", "INE129A01019", "GAIL (India) Ltd."],
  ["GVT&D", "EQ", "INE200A01026", "GE Vernova T&D India Ltd."],
  ["GMRAIRPORT", "EQ", "INE776C01039", "GMR Airports Ltd."],
  ["GABRIEL", "EQ", "INE524A01029", "Gabriel India Ltd."],
  ["GALLANTT", "EQ", "INE297H01019", "Gallantt Ispat Ltd."],
  ["GRSE", "EQ", "INE382Z01011", "Garden Reach Shipbuilders & Engineers Ltd."],
  ["GICRE", "EQ", "INE481Y01014", "General Insurance Corporation of India"],
  ["GILLETTE", "EQ", "INE322A01010", "Gillette India Ltd."],
  ["GLAND", "EQ", "INE068V01023", "Gland Pharma Ltd."],
  ["GLAXO", "EQ", "INE159A01016", "Glaxosmithkline Pharmaceuticals Ltd."],
  ["GLENMARK", "EQ", "INE935A01035", "Glenmark Pharmaceuticals Ltd."],
  ["MEDANTA", "EQ", "INE474Q01031", "Global Health Ltd."],
  ["GPIL", "EQ", "INE177H01039", "Godawari Power & Ispat Ltd."],
  ["GODFRYPHLP", "EQ", "INE260B01028", "Godfrey Phillips India Ltd."],
  ["GODREJCP", "EQ", "INE102D01028", "Godrej Consumer Products Ltd."],
  ["GODREJIND", "EQ", "INE233A01035", "Godrej Industries Ltd."],
  ["GODREJPROP", "EQ", "INE484J01027", "Godrej Properties Ltd."],
  ["GRANULES", "EQ", "INE101D01020", "Granules India Ltd."],
  ["GRAPHITE", "EQ", "INE371A01025", "Graphite India Ltd."],
  ["GRASIM", "EQ", "INE047A01021", "Grasim Industries Ltd."],
  ["GRAVITA", "EQ", "INE024L01027", "Gravita India Ltd."],
  ["GESHIP", "EQ", "INE017A01032", "Great Eastern Shipping Co. Ltd."],
  ["FLUOROCHEM", "EQ", "INE09N301011", "Gujarat Fluorochemicals Ltd."],
  ["GMDCLTD", "EQ", "INE131A01031", "Gujarat Mineral Development Corporation Ltd."],
  ["HBLENGINE", "EQ", "INE292B01021", "HBL Engineering Ltd."],
  ["HCLTECH", "EQ", "INE860A01027", "HCL Technologies Ltd."],
  ["HDBFS", "EQ", "INE756I01012", "HDB Financial Services Ltd."],
  ["HDFCAMC", "EQ", "INE127D01025", "HDFC Asset Management Company Ltd."],
  ["HDFCBANK", "EQ", "INE040A01034", "HDFC Bank Ltd."],
  ["HDFCLIFE", "EQ", "INE795G01014", "HDFC Life Insurance Company Ltd."],
  ["HEGAM", "EQ", "INE545A01024", "HEG Advanced Materials Ltd."],
  ["HFCL", "BE", "INE548A01028", "HFCL Ltd."],
  ["HAVELLS", "EQ", "INE176B01034", "Havells India Ltd."],
  ["HEROMOTOCO", "EQ", "INE158A01026", "Hero MotoCorp Ltd."],
  ["HEXT", "EQ", "INE093A01041", "Hexaware Technologies Ltd."],
  ["HSCL", "EQ", "INE019C01026", "Himadri Speciality Chemical Ltd."],
  ["HINDALCO", "EQ", "INE038A01020", "Hindalco Industries Ltd."],
  ["HAL", "EQ", "INE066F01020", "Hindustan Aeronautics Ltd."],
  ["HINDCOPPER", "EQ", "INE531E01026", "Hindustan Copper Ltd."],
  ["HINDPETRO", "EQ", "INE094A01015", "Hindustan Petroleum Corporation Ltd."],
  ["HINDUNILVR", "EQ", "INE030A01027", "Hindustan Unilever Ltd."],
  ["HINDZINC", "EQ", "INE267A01025", "Hindustan Zinc Ltd."],
  ["POWERINDIA", "EQ", "INE07Y701011", "Hitachi Energy India Ltd."],
  ["HOMEFIRST", "EQ", "INE481N01025", "Home First Finance Company India Ltd."],
  ["HONASA", "EQ", "INE0J5401028", "Honasa Consumer Ltd."],
  ["HONAUT", "EQ", "INE671A01010", "Honeywell Automation India Ltd."],
  ["HUDCO", "EQ", "INE031A01017", "Housing & Urban Development Corporation Ltd."],
  ["HYUNDAI", "EQ", "INE0V6F01027", "Hyundai Motor India Ltd."],
  ["ICICIBANK", "EQ", "INE090A01021", "ICICI Bank Ltd."],
  ["ICICIGI", "EQ", "INE765G01017", "ICICI Lombard General Insurance Company Ltd."],
  ["ICICIAMC", "EQ", "INE346A01027", "ICICI Prudential Asset Management Company Ltd."],
  ["ICICIPRULI", "EQ", "INE726G01019", "ICICI Prudential Life Insurance Company Ltd."],
  ["IDBI", "EQ", "INE008A01015", "IDBI Bank Ltd."],
  ["IDFCFIRSTB", "EQ", "INE092T01019", "IDFC First Bank Ltd."],
  ["IFCI", "EQ", "INE039A01010", "IFCI Ltd."],
  ["IIFL", "EQ", "INE530B01024", "IIFL Finance Ltd."],
  ["INOXINDIA", "EQ", "INE616N01034", "INOX India Ltd."],
  ["IRB", "EQ", "INE821I01022", "IRB Infrastructure Developers Ltd."],
  ["IRCON", "EQ", "INE962Y01021", "IRCON International Ltd."],
  ["ITCHOTELS", "EQ", "INE379A01028", "ITC Hotels Ltd."],
  ["ITC", "EQ", "INE154A01025", "ITC Ltd."],
  ["ITI", "EQ", "INE248A01017", "ITI Ltd."],
  ["INDIACEM", "EQ", "INE383A01012", "India Cements Ltd."],
  ["INDIAMART", "EQ", "INE933S01016", "Indiamart Intermesh Ltd."],
  ["INDIANB", "EQ", "INE562A01011", "Indian Bank"],
  ["IEX", "EQ", "INE022Q01020", "Indian Energy Exchange Ltd."],
  ["INDHOTEL", "EQ", "INE053A01029", "Indian Hotels Co. Ltd."],
  ["IOC", "EQ", "INE242A01010", "Indian Oil Corporation Ltd."],
  ["IOB", "EQ", "INE565A01014", "Indian Overseas Bank"],
  ["IRCTC", "EQ", "INE335Y01020", "Indian Railway Catering And Tourism Corporation Ltd."],
  ["IRFC", "EQ", "INE053F01010", "Indian Railway Finance Corporation Ltd."],
  ["IREDA", "EQ", "INE202E01016", "Indian Renewable Energy Development Agency Ltd."],
  ["IGL", "EQ", "INE203G01027", "Indraprastha Gas Ltd."],
  ["INDUSTOWER", "EQ", "INE121J01017", "Indus Towers Ltd."],
  ["INDUSINDBK", "EQ", "INE095A01012", "IndusInd Bank Ltd."],
  ["NAUKRI", "EQ", "INE663F01032", "Info Edge (India) Ltd."],
  ["INFY", "EQ", "INE009A01021", "Infosys Ltd."],
  ["INOXWIND", "EQ", "INE066P01011", "Inox Wind Ltd."],
  ["INTELLECT", "EQ", "INE306R01017", "Intellect Design Arena Ltd."],
  ["INDIGO", "EQ", "INE646L01027", "InterGlobe Aviation Ltd."],
  ["IGIL", "EQ", "INE0Q9301021", "International Gemological Institute Ltd."],
  ["IKS", "EQ", "INE115Q01022", "Inventurus Knowledge Solutions Ltd."],
  ["IPCALAB", "EQ", "INE571A01038", "Ipca Laboratories Ltd."],
  ["JKCEMENT", "EQ", "INE823G01014", "J.K. Cement Ltd."],
  ["JBMA", "EQ", "INE927D01051", "JBM Auto Ltd."],
  ["JKTYRE", "EQ", "INE573A01042", "JK Tyre & Industries Ltd."],
  ["JMFINANCIL", "EQ", "INE780C01023", "JM Financial Ltd."],
  ["JSWCEMENT", "EQ", "INE718I01012", "JSW Cement Ltd."],
  ["JSWENERGY", "EQ", "INE121E01018", "JSW Energy Ltd."],
  ["JSWINFRA", "EQ", "INE880J01026", "JSW Infrastructure Ltd."],
  ["JSWSTEEL", "EQ", "INE019A01038", "JSW Steel Ltd."],
  ["JAINREC", "EQ", "INE0YD401026", "Jain Resource Recycling Ltd."],
  ["JPPOWER", "EQ", "INE351F01018", "Jaiprakash Power Ventures Ltd."],
  ["J&KBANK", "EQ", "INE168A01041", "Jammu & Kashmir Bank Ltd."],
  ["JINDALSAW", "EQ", "INE324A01032", "Jindal Saw Ltd."],
  ["JSL", "EQ", "INE220G01021", "Jindal Stainless Ltd."],
  ["JINDALSTEL", "EQ", "INE749A01030", "Jindal Steel Ltd."],
  ["JIOFIN", "EQ", "INE758E01017", "Jio Financial Services Ltd."],
  ["JUBLFOOD", "EQ", "INE797F01020", "Jubilant Foodworks Ltd."],
  ["JUBLINGREA", "EQ", "INE0BY001018", "Jubilant Ingrevia Ltd."],
  ["JWL", "EQ", "INE209L01016", "Jupiter Wagons Ltd."],
  ["JYOTICNC", "EQ", "INE980O01024", "Jyoti CNC Automation Ltd."],
  ["KPRMILL", "EQ", "INE930H01031", "K.P.R. Mill Ltd."],
  ["KEI", "EQ", "INE878B01027", "KEI Industries Ltd."],
  ["KPITTECH", "EQ", "INE04I401011", "KPIT Technologies Ltd."],
  ["KSB", "EQ", "INE999A01023", "KSB Ltd."],
  ["KAJARIACER", "EQ", "INE217B01036", "Kajaria Ceramics Ltd."],
  ["KPIL", "EQ", "INE220B01022", "Kalpataru Projects International Ltd."],
  ["KALYANKJIL", "EQ", "INE303R01014", "Kalyan Jewellers India Ltd."],
  ["KARURVYSYA", "EQ", "INE036D01028", "Karur Vysya Bank Ltd."],
  ["KAYNES", "EQ", "INE918Z01012", "Kaynes Technology India Ltd."],
  ["KEC", "EQ", "INE389H01022", "Kec International Ltd."],
  ["KFINTECH", "EQ", "INE138Y01010", "Kfin Technologies Ltd."],
  ["KIRLOSBROS", "EQ", "INE732A01036", "Kirloskar Brothers Ltd."],
  ["KIRLOSENG", "EQ", "INE146L01010", "Kirloskar Oil Eng Ltd."],
  ["KOTAKBANK", "EQ", "INE237A01036", "Kotak Mahindra Bank Ltd."],
  ["KIMS", "EQ", "INE967H01025", "Krishna Institute of Medical Sciences Ltd."],
  ["LTF", "EQ", "INE498L01015", "L&T Finance Ltd."],
  ["LTTS", "EQ", "INE010V01017", "L&T Technology Services Ltd."],
  ["LGEINDIA", "EQ", "INE324D01010", "LG Electronics India Ltd."],
  ["LICHSGFIN", "EQ", "INE115A01026", "LIC Housing Finance Ltd."],
  ["LTFOODS", "EQ", "INE818H01020", "LT Foods Ltd."],
  ["LTM", "EQ", "INE214T01019", "LTM Ltd."],
  ["LT", "EQ", "INE018A01030", "Larsen & Toubro Ltd."],
  ["LAURUSLABS", "EQ", "INE947Q01028", "Laurus Labs Ltd."],
  ["LEMONTREE", "EQ", "INE970X01018", "Lemon Tree Hotels Ltd."],
  ["LENSKART", "EQ", "INE956O01016", "Lenskart Solutions Ltd."],
  ["LICI", "EQ", "INE0J1Y01017", "Life Insurance Corporation of India"],
  ["LINDEINDIA", "EQ", "INE473A01011", "Linde India Ltd."],
  ["LLOYDSME", "EQ", "INE281B01032", "Lloyds Metals And Energy Ltd."],
  ["LODHA", "EQ", "INE670K01029", "Lodha Developers Ltd."],
  ["LUPIN", "EQ", "INE326A01037", "Lupin Ltd."],
  ["MMTC", "EQ", "INE123F01029", "MMTC Ltd."],
  ["MRF", "EQ", "INE883A01011", "MRF Ltd."],
  ["MTARTECH", "EQ", "INE864I01014", "MTAR Technologies Ltd."],
  ["MGL", "EQ", "INE002S01010", "Mahanagar Gas Ltd."],
  ["M&MFIN", "EQ", "INE774D01024", "Mahindra & Mahindra Financial Services Ltd."],
  ["M&M", "EQ", "INE101A01026", "Mahindra & Mahindra Ltd."],
  ["MANAPPURAM", "EQ", "INE522D01027", "Manappuram Finance Ltd."],
  ["MRPL", "EQ", "INE103A01014", "Mangalore Refinery & Petrochemicals Ltd."],
  ["MANKIND", "EQ", "INE634S01028", "Mankind Pharma Ltd."],
  ["MARICO", "EQ", "INE196A01026", "Marico Ltd."],
  ["MARUTI", "EQ", "INE585B01010", "Maruti Suzuki India Ltd."],
  ["MFSL", "EQ", "INE180A01020", "Max Financial Services Ltd."],
  ["MAXHEALTH", "EQ", "INE027H01010", "Max Healthcare Institute Ltd."],
  ["MAZDOCK", "EQ", "INE249Z01020", "Mazagoan Dock Shipbuilders Ltd."],
  ["MEESHO", "EQ", "INE0VDM01015", "Meesho Ltd."],
  ["MINDACORP", "EQ", "INE842C01021", "Minda Corporation Ltd."],
  ["MSUMI", "EQ", "INE0FS801015", "Motherson Sumi Wiring India Ltd."],
  ["MOTILALOFS", "EQ", "INE338I01027", "Motilal Oswal Financial Services Ltd."],
  ["MPHASIS", "EQ", "INE356A01018", "MphasiS Ltd."],
  ["MCX", "EQ", "INE745G01043", "Multi Commodity Exchange of India Ltd."],
  ["MUTHOOTFIN", "EQ", "INE414G01012", "Muthoot Finance Ltd."],
  ["NATCOPHARM", "EQ", "INE987B01026", "NATCO Pharma Ltd."],
  ["NBCC", "EQ", "INE095N01031", "NBCC (India) Ltd."],
  ["NCC", "EQ", "INE868B01028", "NCC Ltd."],
  ["NHPC", "EQ", "INE848E01016", "NHPC Ltd."],
  ["NLCINDIA", "EQ", "INE589A01014", "NLC India Ltd."],
  ["NMDC", "EQ", "INE584A01023", "NMDC Ltd."],
  ["NSLNISP", "EQ", "INE0NNS01018", "NMDC Steel Ltd."],
  ["NTPCGREEN", "EQ", "INE0ONG01011", "NTPC Green Energy Ltd."],
  ["NTPC", "EQ", "INE733E01010", "NTPC Ltd."],
  ["NH", "EQ", "INE410P01011", "Narayana Hrudayalaya Ltd."],
  ["NATIONALUM", "EQ", "INE139A01034", "National Aluminium Co. Ltd."],
  ["NAVA", "EQ", "INE725A01030", "Nava Ltd."],
  ["NAVINFLUOR", "EQ", "INE048G01026", "Navin Fluorine International Ltd."],
  ["NESTLEIND", "EQ", "INE239A01024", "Nestle India Ltd."],
  ["NETWEB", "EQ", "INE0NT901020", "Netweb Technologies India Ltd."],
  ["NEULANDLAB", "EQ", "INE794A01010", "Neuland Laboratories Ltd."],
  ["NAM-INDIA", "EQ", "INE298J01013", "Nippon Life India Asset Management Ltd."],
  ["NUVAMA", "EQ", "INE531F01023", "Nuvama Wealth Management Ltd."],
  ["NUVOCO", "EQ", "INE118D01016", "Nuvoco Vistas Corporation Ltd."],
  ["OBEROIRLTY", "EQ", "INE093I01010", "Oberoi Realty Ltd."],
  ["ONGC", "EQ", "INE213A01029", "Oil & Natural Gas Corporation Ltd."],
  ["OIL", "EQ", "INE274J01014", "Oil India Ltd."],
  ["OLAELEC", "EQ", "INE0LXG01040", "Ola Electric Mobility Ltd."],
  ["OLECTRA", "EQ", "INE260D01016", "Olectra Greentech Ltd."],
  ["PAYTM", "EQ", "INE982J01020", "One 97 Communications Ltd."],
  ["ONESOURCE", "EQ", "INE013P01021", "Onesource Specialty Pharma Ltd."],
  ["OFSS", "EQ", "INE881D01027", "Oracle Financial Services Software Ltd."],
  ["POLICYBZR", "EQ", "INE417T01026", "PB Fintech Ltd."],
  ["PCBL", "EQ", "INE602A01031", "PCBL Chemical Ltd."],
  ["PGEL", "EQ", "INE457L01029", "PG Electroplast Ltd."],
  ["PIIND", "EQ", "INE603J01030", "PI Industries Ltd."],
  ["PNBHOUSING", "EQ", "INE572E01012", "PNB Housing Finance Ltd."],
  ["PTCIL", "EQ", "INE596F01018", "PTC Industries Ltd."],
  ["PVRINOX", "EQ", "INE191H01014", "PVR INOX Ltd."],
  ["PAGEIND", "EQ", "INE761H01022", "Page Industries Ltd."],
  ["PARADEEP", "EQ", "INE088F01024", "Paradeep Phosphates Ltd."],
  ["PATANJALI", "EQ", "INE619A01035", "Patanjali Foods Ltd."],
  ["PERSISTENT", "EQ", "INE262H01021", "Persistent Systems Ltd."],
  ["PETRONET", "EQ", "INE347G01014", "Petronet LNG Ltd."],
  ["PHOENIXLTD", "EQ", "INE211B01039", "Phoenix Mills Ltd."],
  ["PWL", "EQ", "INE0LP301011", "Physicswallah Ltd."],
  ["PIDILITIND", "EQ", "INE318A01026", "Pidilite Industries Ltd."],
  ["PINELABS", "EQ", "INE15B701018", "Pine Labs Ltd."],
  ["PIRAMALFIN", "EQ", "INE202B01038", "Piramal Finance Ltd."],
  ["PPLPHARMA", "EQ", "INE0DK501011", "Piramal Pharma Ltd."],
  ["POLYMED", "EQ", "INE205C01021", "Poly Medicure Ltd."],
  ["POLYCAB", "EQ", "INE455K01017", "Polycab India Ltd."],
  ["POONAWALLA", "EQ", "INE511C01022", "Poonawalla Fincorp Ltd."],
  ["PFC", "EQ", "INE134E01011", "Power Finance Corporation Ltd."],
  ["POWERGRID", "EQ", "INE752E01010", "Power Grid Corporation of India Ltd."],
  ["PREMIERENE", "EQ", "INE0BS701011", "Premier Energies Ltd."],
  ["PRESTIGE", "EQ", "INE811K01011", "Prestige Estates Projects Ltd."],
  ["PFOCUS", "EQ", "INE367G01038", "Prime Focus Ltd."],
  ["PRIVISCL", "EQ", "INE959A01019", "Privi Speciality Chemicals Ltd."],
  ["PNB", "EQ", "INE160A01022", "Punjab National Bank"],
  ["RRKABEL", "EQ", "INE777K01022", "R R Kabel Ltd."],
  ["RBLBANK", "EQ", "INE976G01028", "RBL Bank Ltd."],
  ["RECLTD", "EQ", "INE020B01018", "REC Ltd."],
  ["RHIM", "EQ", "INE743M01012", "RHI MAGNESITA INDIA LTD."],
  ["RITES", "EQ", "INE320J01015", "RITES Ltd."],
  ["RADICO", "EQ", "INE944F01028", "Radico Khaitan Ltd"],
  ["RVNL", "EQ", "INE415G01027", "Rail Vikas Nigam Ltd."],
  ["RAILTEL", "EQ", "INE0DD101019", "Railtel Corporation Of India Ltd."],
  ["RAINBOW", "EQ", "INE961O01016", "Rainbow Childrens Medicare Ltd."],
  ["RKFORGE", "EQ", "INE399G01023", "Ramkrishna Forgings Ltd."],
  ["REDINGTON", "EQ", "INE891D01026", "Redington Ltd."],
  ["RELIANCE", "EQ", "INE002A01018", "Reliance Industries Ltd."],
  ["RPOWER", "EQ", "INE614G01033", "Reliance Power Ltd."],
  ["RUBICON", "EQ", "INE506V01022", "Rubicon Research Ltd."],
  ["SBICARD", "EQ", "INE018E01016", "SBI Cards and Payment Services Ltd."],
  ["SBILIFE", "EQ", "INE123W01016", "SBI Life Insurance Company Ltd."],
  ["SJVN", "EQ", "INE002L01015", "SJVN Ltd."],
  ["SHRIPISTON", "EQ", "INE526E01018", "SPR Auto Technologies Ltd."],
  ["SRF", "EQ", "INE647A01010", "SRF Ltd."],
  ["SAGILITY", "EQ", "INE0W2G01015", "Sagility Ltd."],
  ["SAILIFE", "EQ", "INE570L01029", "Sai Life Sciences Ltd."],
  ["SAMMAANCAP", "EQ", "INE148I01020", "Sammaan Capital Ltd."],
  ["MOTHERSON", "EQ", "INE775A01035", "Samvardhana Motherson International Ltd."],
  ["SANSERA", "EQ", "INE953O01021", "Sansera Engineering Ltd."],
  ["SARDAEN", "EQ", "INE385C01021", "Sarda Energy and Minerals Ltd."],
  ["SCHAEFFLER", "EQ", "INE513A01022", "Schaeffler India Ltd."],
  ["SCHNEIDER", "EQ", "INE839M01018", "Schneider Electric Infrastructure Ltd."],
  ["SCI", "EQ", "INE109A01011", "Shipping Corporation of India Ltd."],
  ["SHREECEM", "EQ", "INE070A01015", "Shree Cement Ltd."],
  ["SHRIRAMFIN", "EQ", "INE721A01047", "Shriram Finance Ltd."],
  ["SHYAMMETL", "EQ", "INE810G01011", "Shyam Metalics and Energy Ltd."],
  ["ENRIN", "EQ", "INE1NPP01017", "Siemens Energy India Ltd."],
  ["SIEMENS", "EQ", "INE003A01024", "Siemens Ltd."],
  ["SIGNATURE", "EQ", "INE903U01023", "Signatureglobal (India) Ltd."],
  ["SOBHA", "EQ", "INE671H01015", "Sobha Ltd."],
  ["SOLARINDS", "EQ", "INE343H01029", "Solar Industries India Ltd."],
  ["SONACOMS", "EQ", "INE073K01018", "Sona BLW Precision Forgings Ltd."],
  ["STARHEALTH", "EQ", "INE575P01011", "Star Health and Allied Insurance Company Ltd."],
  ["SBIN", "EQ", "INE062A01020", "State Bank of India"],
  ["SAIL", "EQ", "INE114A01011", "Steel Authority of India Ltd."],
  ["STLTECH", "BE", "INE089C01029", "Sterlite Technologies Ltd."],
  ["SUMICHEM", "EQ", "INE258G01013", "Sumitomo Chemical India Ltd."],
  ["SUNPHARMA", "EQ", "INE044A01036", "Sun Pharmaceutical Industries Ltd."],
  ["SUNTV", "EQ", "INE424H01027", "Sun TV Network Ltd."],
  ["SUNDARMFIN", "EQ", "INE660A01013", "Sundaram Finance Ltd."],
  ["SUPREMEIND", "EQ", "INE195A01028", "Supreme Industries Ltd."],
  ["SUZLON", "EQ", "INE040H01021", "Suzlon Energy Ltd."],
  ["SWANCORP", "EQ", "INE665A01038", "Swan Corp Ltd."],
  ["SWIGGY", "EQ", "INE00H001014", "Swiggy Ltd."],
  ["SYNGENE", "EQ", "INE398R01022", "Syngene International Ltd."],
  ["SYRMA", "EQ", "INE0DYJ01015", "Syrma SGS Technology Ltd."],
  ["TBOTEK", "EQ", "INE673O01025", "TBO Tek Ltd."],
  ["TDPOWERSYS", "EQ", "INE419M01035", "TD Power Systems Ltd."],
  ["TVSMOTOR", "EQ", "INE494B01023", "TVS Motor Company Ltd."],
  ["TATACAP", "EQ", "INE976I01016", "Tata Capital Ltd."],
  ["TATACHEM", "EQ", "INE092A01019", "Tata Chemicals Ltd."],
  ["TATACOMM", "EQ", "INE151A01013", "Tata Communications Ltd."],
  ["TCS", "EQ", "INE467B01029", "Tata Consultancy Services Ltd."],
  ["TATACONSUM", "EQ", "INE192A01025", "Tata Consumer Products Ltd."],
  ["TATAELXSI", "EQ", "INE670A01012", "Tata Elxsi Ltd."],
  ["TATAINVEST", "EQ", "INE672A01026", "Tata Investment Corporation Ltd."],
  ["TMCV", "EQ", "INE1TAE01010", "Tata Motors Ltd."],
  ["TMPV", "EQ", "INE155A01022", "Tata Motors Passenger Vehicles Ltd."],
  ["TATAPOWER", "EQ", "INE245A01021", "Tata Power Co. Ltd."],
  ["TATASTEEL", "EQ", "INE081A01020", "Tata Steel Ltd."],
  ["TATATECH", "EQ", "INE142M01025", "Tata Technologies Ltd."],
  ["TTML", "EQ", "INE517B01013", "Tata Teleservices (Maharashtra) Ltd."],
  ["TECHM", "EQ", "INE669C01036", "Tech Mahindra Ltd."],
  ["TECHNOE", "EQ", "INE285K01026", "Techno Electric & Engineering Company Ltd."],
  ["TEGA", "EQ", "INE011K01018", "Tega Industries Ltd."],
  ["TEJASNET", "EQ", "INE010J01012", "Tejas Networks Ltd."],
  ["TENNIND", "EQ", "INE19RI01016", "Tenneco Clean Air India Ltd."],
  ["THANGAMAYL", "EQ", "INE085J01014", "Thangamayil Jewellery Ltd."],
  ["NIACL", "EQ", "INE470Y01017", "The New India Assurance Company Ltd."],
  ["RAMCOCEM", "EQ", "INE331A01037", "The Ramco Cements Ltd."],
  ["THERMAX", "EQ", "INE152A01029", "Thermax Ltd."],
  ["TIMKEN", "EQ", "INE325A01013", "Timken India Ltd."],
  ["TITAGARH", "EQ", "INE615H01020", "Titagarh Rail Systems Ltd."],
  ["TITAN", "EQ", "INE280A01028", "Titan Company Ltd."],
  ["TORNTPHARM", "EQ", "INE685A01028", "Torrent Pharmaceuticals Ltd."],
  ["TORNTPOWER", "EQ", "INE813H01021", "Torrent Power Ltd."],
  ["TARIL", "EQ", "INE763I01026", "Transformers And Rectifiers (India) Ltd."],
  ["TRENT", "EQ", "INE849A01020", "Trent Ltd."],
  ["TRIDENT", "EQ", "INE064C01022", "Trident Ltd."],
  ["TRITURBINE", "EQ", "INE152M01016", "Triveni Turbine Ltd."],
  ["TIINDIA", "EQ", "INE974X01010", "Tube Investments of India Ltd."],
  ["UCOBANK", "EQ", "INE691A01018", "UCO Bank"],
  ["UNOMINDA", "EQ", "INE405E01023", "UNO Minda Ltd."],
  ["UPL", "EQ", "INE628A01036", "UPL Ltd."],
  ["UTIAMC", "EQ", "INE094J01016", "UTI Asset Management Company Ltd."],
  ["ULTRACEMCO", "EQ", "INE481G01011", "UltraTech Cement Ltd."],
  ["UNIONBANK", "EQ", "INE692A01016", "Union Bank of India"],
  ["UBL", "EQ", "INE686F01025", "United Breweries Ltd."],
  ["UNITDSPR", "EQ", "INE854D01024", "United Spirits Ltd."],
  ["URBANCO", "EQ", "INE0CAZ01013", "Urban Company Ltd."],
  ["USHAMART", "EQ", "INE228A01035", "Usha Martin Ltd."],
  ["VTL", "EQ", "INE825A01020", "Vardhman Textiles Ltd."],
  ["VBL", "EQ", "INE200M01039", "Varun Beverages Ltd."],
  ["VAML", "EQ", "INE1CDF01017", "Vedanta Aluminium Metal Ltd."],
  ["VISL", "EQ", "INE1CLE01013", "Vedanta Iron and Steel Ltd."],
  ["VEDL", "EQ", "INE205A01025", "Vedanta Ltd."],
  ["VOGL", "EQ", "INE704J01044", "Vedanta Oil and Gas Ltd."],
  ["VEDPOWER", "EQ", "INE694L01019", "Vedanta Power Ltd."],
  ["VIJAYA", "EQ", "INE043W01024", "Vijaya Diagnostic Centre Ltd."],
  ["VMM", "EQ", "INE01EA01019", "Vishal Mega Mart Ltd."],
  ["IDEA", "EQ", "INE669E01016", "Vodafone Idea Ltd."],
  ["VOLTAS", "EQ", "INE226A01021", "Voltas Ltd."],
  ["WAAREEENER", "EQ", "INE377N01017", "Waaree Energies Ltd."],
  ["WELCORP", "EQ", "INE191B01025", "Welspun Corp Ltd."],
  ["WELSPUNLIV", "EQ", "INE192B01031", "Welspun Living Ltd."],
  ["WHIRLPOOL", "EQ", "INE716A01013", "Whirlpool of India Ltd."],
  ["WIPRO", "EQ", "INE075A01022", "Wipro Ltd."],
  ["WOCKPHARMA", "EQ", "INE049B01025", "Wockhardt Ltd."],
  ["YESBANK", "EQ", "INE528G01035", "Yes Bank Ltd."],
  ["ZFCVINDIA", "EQ", "INE342J01019", "ZF Commercial Vehicle Control Systems India Ltd."],
  ["ZEEL", "EQ", "INE256A01028", "Zee Entertainment Enterprises Ltd."],
  ["ZENTEC", "EQ", "INE251B01027", "Zen Technologies Ltd."],
  ["ZENSARTECH", "EQ", "INE520A01027", "Zensar Technolgies Ltd."],
  ["ZYDUSLIFE", "EQ", "INE010B01027", "Zydus Lifesciences Ltd."],
  ["ZYDUSWELL", "EQ", "INE768C01028", "Zydus Wellness Ltd."],
  ["ECLERX", "EQ", "INE738I01010", "eClerx Services Ltd."],
];

export const NIFTY500_CONSTITUENTS: readonly Nifty500Constituent[] =
  RAW_CONSTITUENTS.map(([symbol, series, isin, companyName]) => ({
    symbol,
    series,
    isin,
    companyName,
  }));

export function getNifty500Constituents(): readonly Nifty500Constituent[] {
  return NIFTY500_CONSTITUENTS;
}

/** Returns the official symbols as "NSE:SYMBOL" strings. */
export function getNifty500FullSymbols(): string[] {
  return NIFTY500_CONSTITUENTS.map((c) => `NSE:${c.symbol}`);
}

export function getNifty500Count(): number {
  return NIFTY500_CONSTITUENTS.length;
}

/**
 * Kite trading symbols to try for a constituent, in priority order.
 *
 * Non-EQ series live under a suffixed symbol in Kite. The base symbol (and the
 * pre-rename symbol) remain as fallbacks; the seeder treats more than one
 * active hit as ambiguous rather than choosing arbitrarily.
 */
export function resolveNifty500Candidates(c: Nifty500Constituent): string[] {
  const mapped = NIFTY500_SYMBOL_ALIASES[c.symbol] ?? c.symbol;
  const candidates: string[] = [];
  if (c.series !== "EQ") candidates.push(`${mapped}-${c.series}`);
  candidates.push(mapped);
  if (mapped !== c.symbol) candidates.push(c.symbol);
  return [...new Set(candidates)];
}

/**
 * Reject corrupt or partial source snapshots. A full scan must never treat a
 * truncated list as a complete universe.
 */
export function validateNifty500Source(
  constituents: readonly Nifty500Constituent[] = NIFTY500_CONSTITUENTS
): void {
  const problems: string[] = [];
  if (constituents.length < NIFTY500_MIN_EXPECTED) {
    problems.push(
      `expected at least ${NIFTY500_MIN_EXPECTED} constituents, got ${constituents.length}`
    );
  }

  const seenSymbols = new Set<string>();
  const seenIsins = new Set<string>();
  for (const c of constituents) {
    if (!/^[A-Z0-9&-]+$/.test(c.symbol)) {
      problems.push(`invalid symbol '${c.symbol}'`);
    }
    if (!/^[A-Z0-9]{12}$/.test(c.isin)) {
      problems.push(`invalid ISIN '${c.isin}' for ${c.symbol}`);
    }
    if (!c.companyName.trim()) {
      problems.push(`blank company name for ${c.symbol}`);
    }
    if (!["EQ", "BE", "RR"].includes(c.series)) {
      problems.push(`unsupported series '${c.series}' for ${c.symbol}`);
    }
    if (c.symbol in NIFTY500_EXCLUDED_PLACEHOLDERS) {
      problems.push(`placeholder ${c.symbol} must not be in the universe`);
    }
    if (seenSymbols.has(c.symbol)) {
      problems.push(`duplicate symbol '${c.symbol}'`);
    }
    if (seenIsins.has(c.isin)) {
      problems.push(`duplicate ISIN '${c.isin}'`);
    }
    seenSymbols.add(c.symbol);
    seenIsins.add(c.isin);
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid Nifty 500 source data: ${problems.slice(0, 10).join("; ")}` +
        (problems.length > 10 ? ` (+${problems.length - 10} more)` : "")
    );
  }
}
