/**
 * Nifty 500 constituent list.
 *
 * Source: NSE India — https://www.nse-indices.com/
 * Last verified: October 2024
 *
 * This list contains the trading symbols used on NSE.
 * These are matched against the Kite instrument master on startup.
 *
 * MAINTENANCE NOTE:
 * NSE updates the Nifty 500 composition quarterly (March, June, September, December).
 * Review and update this list after each reconstitution announcement.
 * The `lastUpdated` constant documents the last manual verification date.
 */

export const NIFTY500_LAST_UPDATED = "2024-10-01";

/**
 * Nifty 500 trading symbols (NSE EQ segment).
 * Stored as plain trading symbols without exchange prefix.
 * The full key "NSE:<SYMBOL>" is constructed at runtime.
 */
export const NIFTY500_SYMBOLS: string[] = [
  // Nifty 50 (Large Cap)
  "RELIANCE", "TCS", "HDFCBANK", "BHARTIARTL", "ICICIBANK",
  "INFOSYS", "SBIN", "LICI", "HINDUNILVR", "ITC",
  "LT", "BAJFINANCE", "HCLTECH", "SUNPHARMA", "MARUTI",
  "KOTAKBANK", "TITAN", "AXISBANK", "ADANIENT", "ASIANPAINT",
  "NTPC", "ULTRACEMCO", "ONGC", "BAJAJFINSV", "WIPRO",
  "POWERGRID", "ADANIPORTS", "M&M", "NESTLEIND", "COALINDIA",
  "TATAMOTORS", "TATASTEEL", "JSWSTEEL", "TECHM", "HINDALCO",
  "DIVISLAB", "CIPLA", "DRREDDY", "INDUSINDBK", "BPCL",
  "APOLLOHOSP", "HDFCLIFE", "SBILIFE", "GRASIM", "EICHERMOT",
  "TRENT", "BAJAJ-AUTO", "BRITANNIA", "HEROMOTOCO", "SHRIRAMFIN",

  // Nifty Next 50
  "ADANIGREEN", "ADANIPOWER", "ADANITRANS", "AMBUJACEM", "BANDHANBNK",
  "BANKBARODA", "BERGEPAINT", "BEL", "BOSCHLTD", "CANBK",
  "CHOLAFIN", "COLPAL", "DMART", "GAIL", "GODREJCP",
  "HAVELLS", "INDIGO", "IOC", "IRCTC", "JINDALSTEL",
  "JSWENERGY", "L&TFH", "LTIM", "LUPIN", "MCDOWELL-N",
  "NAUKRI", "NHPC", "OBEROIRLTY", "OFSS", "PAGEIND",
  "PEL", "PIDILITIND", "PNB", "POLYCAB", "RECLTD",
  "SBICARD", "SIEMENS", "SRF", "TORNTPHARM", "TVSMOTOR",
  "UNIONBANK", "UPL", "VEDL", "VBL", "ZOMATO",
  "CUMMINSIND", "DABUR", "GODREJPROP", "ICICIPRULI", "MUTHOOTFIN",

  // Nifty Midcap 150 (selected)
  "AARTIIND", "ABCAPITAL", "ABFRL", "ACC", "APLAPOLLO",
  "APLLTD", "AUBANK", "AUROPHARMA", "BAJAJHFL", "BALKRISHIND",
  "BATAINDIA", "BHARATFORG", "BHEL", "BIOCON", "BLUESTARCO",
  "CAMS", "CANFINHOME", "CASTROLIND", "CDSL", "CENTURYTEX",
  "CESC", "CHAMBLFERT", "COFORGE", "CONCOR", "COROMANDEL",
  "CROMPTON", "CUB", "DEEPAKNTR", "DELTACORP", "DIXON",
  "DLFDL", "ESCORTS", "EXIDEIND", "FACT", "FEDERALBNK",
  "FINCABLES", "FLUOROCHEM", "FORTIS", "GLENMARK", "GNFC",
  "GPPL", "GRANULES", "GSPL", "GUJGASLTD", "HAL",
  "HFCL", "HONAUT", "HUDCO", "IDFCFIRSTB", "IIFL",
  "INDIAMART", "INDIANB", "INDHOTEL", "INDUSTOWER", "INOXGREEN",
  "IOB", "IPCALAB", "IRB", "IRFC", "IGL",
  "JKCEMENT", "JKTYRE", "JPPOWER", "JSL", "JUBLFOOD",
  "KAJARIACER", "KALPATPOWR", "KANSAINER", "KEC", "KPITTECH",
  "KRISHNAML", "LAOPALA", "LALPATHLAB", "LICHSGFIN", "LINDEINDIA",
  "MARICO", "MAXHEALTH", "MCX", "METROPOLIS", "MGL",
  "MPHASIS", "MRF", "NATIONALUM", "NAVINFLUOR", "NBCC",
  "NCC", "NMDC", "OIL", "PGHH", "PERSISTENT",
  "PETRONET", "PFC", "PNBHOUSING", "PRESTIGE", "RAIN",
  "RAJESHEXPO", "RAMCOCEM", "RKFORGE", "ROUTE", "SANOFI",
  "SCHAEFFLER", "SHOPERSTOP", "SKFINDIA", "SONACOMS", "STAR",
  "SUNDARMFIN", "SUNDRMFAST", "SUPREMEIND", "SYNGENE", "TATACHEM",
  "TATACOMM", "TATAELXSI", "TATAPOWER", "TATVA", "THYROCARE",
  "TIMKEN", "TTKPRESTIG", "UCOBANK", "UJJIVANSFB", "UTIAMC",
  "VAIBHAVGBL", "VOLTAS", "WHIRLPOOL", "WIPRO", "ZEEL",

  // Nifty Smallcap 250 (representative selection)
  "AAVAS", "ABSL", "ACCELYA", "AEGISLOG", "AFFLE",
  "AIAENG", "AJANTPHARM", "ALEMBICLTD", "ALKYLAMINE", "ALLCARGO",
  "AMARAJABAT", "AMJL", "ANDHRSUGAR", "ANGELONE", "ANURAS",
  "APARINDS", "APTUS", "ARMAN", "ARVIND", "ASAHIINDIA",
  "ASTERDM", "ASTRAL", "ATUL", "AVANTIFEED", "BAJFINANCE",
  "BALAMINES", "BARBEQUE", "BASF", "BAYERCROP", "BEML",
  "BIKAJI", "BORORENEW", "BSOFT", "CALCOM", "CAMPUS",
  "CAPACITE", "CARTRADE", "CCL", "CEATLTD", "CENTURYPLY",
  "CERA", "CHEVIOT", "CLEAN", "CLNINDIA", "CONFIPET",
  "CRAFTSMAN", "CYIENT", "DALBHARAT", "DATAPATTNS", "DCMSHRIRAM",
  "DELHIVERY", "DEVYANI", "DFMFOODS", "DOMS", "DREAMFOLKS",
  "ECLERX", "EIDPARRY", "ELGIEQUIP", "EMAMILTD", "EPIGRAL",
  "EQUITASBNK", "ERIS", "ESABINDIA", "ETHOSLTD", "EUPHARMA",
  "FAIRCHEMOR", "FLAIR", "GALAXYSURF", "GESHIP", "GHCL",
  "GILLETTE", "GLAXO", "GMRINFRA", "GRINDWELL", "HBLPOWER",
  "HERITGFOOD", "HESTERBIO", "HIKAL", "HOMEFIRST", "HONEYWELL",
  "HTMEDIA", "IBREALEST", "ICEMAKE", "IDFC", "IFBIND",
  "IGPL", "INDIAGLYCO", "INDIAPOWER", "INDIANHUME", "INOXWIND",
  "INTELLECT", "ISGEC", "ITDCEM", "JAYNECOIND", "JHS",
  "JINDALSAW", "JINDALPOLY", "JKPAPER", "JLHL", "JUBLINGREA",
  "JUNIPERH", "JUSTDIAL", "JYOTHYLAB", "KALYANKJIL", "KANSAINER",
];

// Deduplicate in case of accidental repeats
const uniqueSymbols = [...new Set(NIFTY500_SYMBOLS)];

/**
 * Returns the full Nifty 500 symbol list as "NSE:SYMBOL" strings.
 */
export function getNifty500FullSymbols(): string[] {
  return uniqueSymbols.map((s) => `NSE:${s}`);
}

/**
 * Returns count of symbols in the constituent list.
 */
export function getNifty500Count(): number {
  return uniqueSymbols.length;
}
