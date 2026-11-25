// The long conversation: a day's work with one agent through half a year of support tickets, long
// enough that its earlier steps are summarized three times. What grows its requests is the work
// itself: each week it reads the four regions' ticket files whole, about 24,000 characters each,
// and adds the week to a digest it keeps. After each compaction, three questions check that the
// thread held: something the person said at the start, a step of the work the compaction covered,
// and a line of the agent's memory.
//
// The tickets are made here from a fixed seed, so every run reads the same files and the checks
// know the answers: each week has at least one refund over €500, and some tickets mention a
// chargeback, which the person asks to have listed from week 3 on. Each week's message ends with an
// aside the work never needs, who was on call that week, which only the conversation holds: a
// question about it after a compaction can be answered only from the summary.

export const REGIONS = [
  {
    code: "NO",
    name: "norway",
    people: ["Ingrid", "Lars", "Sigrid", "Ola", "Kari", "Henrik", "Marte", "Jonas"],
  },
  {
    code: "SE",
    name: "sweden",
    people: ["Astrid", "Erik", "Maja", "Johan", "Elsa", "Nils", "Linnea", "Oskar"],
  },
  {
    code: "DK",
    name: "denmark",
    people: ["Freja", "Mads", "Ida", "Rasmus", "Karen", "Søren", "Mette", "Anders"],
  },
  {
    code: "FI",
    name: "finland",
    people: ["Aino", "Mikko", "Helmi", "Juho", "Venla", "Eero", "Sanna", "Ville"],
  },
];
/** The weeks there are to read, more than three compactions take. */
export const WEEKS = 32;
/** From this week on the person asks for chargebacks to be listed too. */
export const CHARGEBACKS_FROM = 3;
/** A ticket file stays under this many characters, so one read of the computer gives it whole. */
const FILE_CHARS = 24_000;
/** Where the agent's computer holds the tickets, and where the person asks for the digest. */
export const TICKETS = "tickets";
export const DIGEST = "reports/digest.md";

const PRODUCTS = [
  "Kettle Pro 2",
  "Brew Mini",
  "AirPure 300",
  "Vacuum S7",
  "Blender X",
  "Toaster Duo",
  "Halo lamp",
  "Scale Fit",
];
const STAFF = ["Mats", "Hanna", "Petra", "Tobias", "Nora", "Emil"];
/** What tickets are about, each with what the customer and support say. */
const ISSUES = [
  {
    issue: "late delivery",
    customer: [
      "My order {order} was due on {day} and still hasn't arrived. The tracking page hasn't moved for {n} days.",
      "I was promised delivery within three days and it has now been {n}. Where is my {product}?",
      "The courier says the parcel for {order} is at a depot, but nobody can tell me when it will come.",
    ],
    support: [
      "I've asked the courier to trace {order}; they expect it on {day}. I'll follow up if it slips again.",
      "Sorry for the wait. The depot had a backlog after the storm; your {product} goes out on the next run.",
    ],
  },
  {
    issue: "damaged on arrival",
    customer: [
      "The {product} arrived with a cracked housing. The box looked fine, so it must have broken in packing.",
      "When I unpacked the {product} the lid was dented and it doesn't close any more.",
      "Order {order} came today and the glass part is shattered. I have photos if you need them.",
    ],
    support: [
      "Thank you for the photos. I've arranged a replacement {product}; the courier will collect the broken one.",
      "I'm sorry it arrived like that. A new unit is on its way and you can keep the damaged one for recycling.",
    ],
  },
  {
    issue: "charged twice",
    customer: [
      "I see two charges for order {order} on my card statement, both on {day}.",
      "Your shop charged me twice for one {product}. Please refund the second payment.",
    ],
    support: [
      "You're right: the payment went through twice when the page timed out. The duplicate is refunded.",
      "I can see both captures. The second one is reversed and should show on your statement within five days.",
    ],
  },
  {
    issue: "can't log in to the app",
    customer: [
      "Since the update I can't log in to the app. It says my password is wrong but it works on the website.",
      "The app keeps sending me back to the login screen after I enter the code from the email.",
    ],
    support: [
      "This is a known problem with version 4.2 of the app. Version 4.2.1 fixes it; please update and try again.",
      "I've reset your session on our side. Please sign out on all devices and sign in again on the app.",
    ],
  },
  {
    issue: "warranty repair",
    customer: [
      "My {product} stopped working after {n} months. It is still under warranty.",
      "The motor in my {product} makes a grinding noise and then cuts out. I bought it in the spring.",
    ],
    support: [
      "That fault is covered. Please send the {product} to our repair centre with the prepaid label I've emailed.",
      "Our technician confirmed the fault from your video. We'll repair it or replace it within ten working days.",
    ],
  },
  {
    issue: "missing parts",
    customer: [
      "The {product} came without the power cable. Everything else is in the box.",
      "My order {order} is missing the second filter that the product page lists as included.",
    ],
    support: [
      "Sorry about that. The missing part ships today in a small parcel; no need to return anything.",
      "I've checked with the warehouse and the batch was packed short. Your part is on its way.",
    ],
  },
  {
    issue: "subscription cancellation",
    customer: [
      "I want to cancel my filter subscription. I've moved and don't need the deliveries any more.",
      "How do I stop the monthly coffee subscription? I can't find the option in my account.",
    ],
    support: [
      "Your subscription is cancelled from the next cycle. You'll get a confirmation email shortly.",
      "I've cancelled it for you. The option is under Account, Subscriptions, Manage, if you need it again.",
    ],
  },
];
/** The issues a big refund comes from. */
const COSTLY = ["damaged on arrival", "charged twice", "warranty repair"];
const CHARGEBACK =
  "Note from billing: the customer has also opened a chargeback with their bank for this order.";

/** A small seeded generator, so every run makes the same files. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, width) => String(n).padStart(width, "0");
const euros = (amount) => `€${amount.toLocaleString("en-GB")}.00`;
/** A week's folder, as the person names it. */
export const weekFolder = (week) => `${TICKETS}/week-${pad(week, 2)}`;

/**
 * The ticket files, by path, and what they hold: for each week, its refunds over €500 and its
 * tickets that mention a chargeback, each with its ticket number, region and amount.
 */
export function tickets() {
  const random = seeded(2026);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const files = {};
  const weeks = [];
  for (let week = 1; week <= WEEKS; week++) {
    const refunds = [];
    const chargebacks = [];
    // At least one big refund a week, in a region of its own; another region may have one too.
    const bigIn = new Set([Math.floor(random() * 4)]);
    if (random() < 0.4) bigIn.add(Math.floor(random() * 4));
    for (const [r, region] of REGIONS.entries()) {
      // Two issues lead each file, so a region's week has an answer to its most common issues.
      const order = [...ISSUES].sort(() => random() - 0.5);
      const weights = order.map((_, i) =>
        i === 0 ? 9 : i === 1 ? 6 : 1 + Math.floor(random() * 3),
      );
      const bag = order.flatMap((one, i) => Array(weights[i]).fill(one));
      const lines = [
        `Support tickets, ${region.name[0].toUpperCase()}${region.name.slice(1)}, week ${week} of 2026`,
        "Exported from the helpdesk: one ticket after another, oldest first.",
        "",
      ];
      let size = lines.join("\n").length;
      let big = bigIn.has(r) ? 1 + Math.floor(random() * 2) : 0;
      let last;
      for (let n = 1; ; n++) {
        const issue = bag.length
          ? bag.splice(Math.floor(random() * bag.length), 1)[0]
          : pick(ISSUES);
        const id = `${region.code}-W${pad(week, 2)}-${pad(n, 3)}`;
        // One product, order, day and count for the whole ticket.
        const values = {
          order: `#${pad(Math.floor(random() * 900000) + 100000, 6)}`,
          product: pick(PRODUCTS),
          day: `${1 + Math.floor(random() * 28)} ${pick(["January", "February", "March", "April", "May", "June"])}`,
          n: String(2 + Math.floor(random() * 9)),
        };
        const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
        const costly = big > 0 && COSTLY.includes(issue.issue) && random() < 0.5;
        const amount = costly
          ? 520 + Math.floor(random() * 1400)
          : random() < 0.35
            ? 15 + Math.floor(random() * 270)
            : 0;
        const chargeback = issue.issue !== "subscription cancellation" && random() < 0.03;
        const block = [
          `Ticket ${id} · opened ${1 + Math.floor(random() * 28)} ${pick(["Jan", "Feb", "Mar", "Apr", "May", "Jun"])} · customer: ${pick(region.people)} · issue: ${issue.issue}`,
          `> Customer: ${fill(pick(issue.customer))}`,
          `> Support (${pick(STAFF)}): ${fill(pick(issue.support))}`,
          ...(random() < 0.5
            ? [
                `> Customer: ${pick(["Thanks, that helps.", "Fine, I'll wait.", "Please hurry, I need it this week.", "OK. Let me know when it's done."])}`,
              ]
            : []),
          ...(chargeback ? [CHARGEBACK] : []),
          `Status: ${pick(["resolved", "resolved", "waiting on customer", "escalated"])} · refund: ${amount ? euros(amount) : "none"}`,
          "",
        ].join("\n");
        if (size + block.length + 1 > FILE_CHARS) break;
        lines.push(block);
        size += block.length + 1;
        last = { id, at: lines.length - 1 };
        if (amount > 500) {
          refunds.push({ id, region: region.code, amount });
          big--;
        }
        if (chargeback) chargebacks.push({ id, region: region.code });
      }
      // A region that was to have a big refund and drew none has it on its last ticket.
      if (big > 0 && !refunds.some((one) => one.region === region.code)) {
        const amount = 520 + Math.floor(random() * 1400);
        lines[last.at] = lines[last.at].replace(/refund: [^\n]*/, `refund: ${euros(amount)}`);
        refunds.push({ id: last.id, region: region.code, amount });
      }
      files[`${weekFolder(week)}/${region.name}.txt`] = lines.join("\n");
    }
    weeks.push({ week, refunds, chargebacks });
  }
  return { files, weeks };
}

/** Each week's on-call, a name no ticket has, with a detail the work never needs. */
const ON_CALL = [
  ["Greta", "she's on leave next week"],
  ["Björn", "he took the night shift too"],
  ["Lotta", "she covered from the Bergen office"],
  ["Pekka", "he swapped with a colleague for it"],
  ["Viggo", "it was his first week on the rota"],
  ["Runa", "she handed over on Friday at noon"],
  ["Tove", "she's moving to the billing team soon"],
  ["Aksel", "he worked it from home"],
  ["Dagny", "she said it was a quiet week"],
  ["Halvor", "he's back from paternity leave"],
  ["Inka", "she trained a new starter alongside"],
  ["Jarl", "he had the spare phone that week"],
  ["Kaisa", "she's running the next workshop"],
  ["Leif", "he asked for Mondays off"],
  ["Malin", "she covered two regions' calls"],
  ["Nanna", "she's off to a conference after"],
  ["Otso", "he rejoined after a long break"],
  ["Pia", "she kept the old pager"],
  ["Rolf", "he's retiring in the spring"],
  ["Saga", "she did it from the Turku office"],
  ["Teemu", "he shared it with a new hire"],
  ["Ulla", "she's switching to mornings"],
  ["Vidar", "he swapped his week for a holiday"],
  ["Wilma", "she ran it from a train"],
  ["Ylva", "she's on leave the week after"],
  ["Arvid", "he took the late calls"],
  ["Birgit", "she's mentoring two new starters"],
  ["Calle", "he picked it up at short notice"],
  ["Dorte", "she worked it from Aarhus"],
  ["Eskil", "he's moving to Stockholm"],
  ["Frida", "she had a cold most of it"],
  ["Gunnar", "he'll be on call again in May"],
];
/** Who was on call in `week`. */
export const onCall = (week) => ON_CALL[(week - 1) % ON_CALL.length][0];

/** What the person says. */
export const SAY = {
  start: `Hi! I'm Dana, and I run customer support for the Nordics. Today I'd like your help going through our ticket exports. They're in ${TICKETS}/, one folder a week and one file a region. For this job, call the regions by their codes, NO, SE, DK and FI, and keep the digest in ${DIGEST}. Nothing to do yet: I'll give you the weeks one at a time.`,
  memory:
    "Please remember this for good, beyond today's job: any refund over €500 needs my sign-off before it is paid.",
  week: (week) =>
    `${week === CHARGEBACKS_FROM ? "From this week on, also list every ticket that mentions a chargeback. " : ""}Week ${week}: read the four region files in ${weekFolder(week)} in full, and add week ${week} to the digest: for each region, its two most common issues, and every refund over €500 with its ticket number. (Week ${week}'s on-call was ${ON_CALL[(week - 1) % ON_CALL.length].join("; ")}.)`,
};

/**
 * The question only the summary can answer: who was on call in `week`, said once as an aside in
 * that week's message. `id` tells a week of the compaction's own from one the first compaction
 * summarized. Whether the name is in the agent's memory or its digest is the runner's to say.
 */
function aside({ week, id }) {
  const name = onCall(week);
  return {
    id,
    name,
    say: `Quick one: who was on call in week ${week}?`,
    expected: { week, name },
    pass: (reply) => new RegExp(`(^|[^\\p{L}])${name}($|[^\\p{L}])`, "u").test(reply),
  };
}

/** Amounts written with a thousands separator read as plain digits. */
const digits = (text) => text.replace(/(\d)[\s,.  ](?=\d{3}\b)/g, "$1");

/**
 * The questions after compaction `k`, each with its check of the reply and of the agent's memory
 * lines. `week` is a week the compaction covered, with its refunds. The asides' questions, each
 * `{ week, id }`, come first: before any question the agent might open the digest for.
 */
export function checks(k, week, asides = []) {
  const largest = week.refunds.reduce((a, b) => (b.amount > a.amount ? b : a));
  const asked = [
    { region: "DK", amount: 640, what: "a damaged blender" },
    { region: "SE", amount: 720, what: "a warranty repair" },
    { region: "FI", amount: 980, what: "a double charge" },
  ][(k - 1) % 3];
  return [
    ...asides.map(aside),
    {
      id: "start",
      say: "Quick check before we go on: where are you keeping the digest, and which codes did I ask you to use for the regions?",
      pass: (reply) =>
        reply.includes(DIGEST) &&
        REGIONS.every(({ code }) => new RegExp(`\\b${code}\\b`).test(reply)),
    },
    {
      id: "step",
      say: `Which ticket had the largest refund in week ${week.week}, and how much was it?`,
      expected: largest,
      pass: (reply) => reply.includes(largest.id) && digits(reply).includes(String(largest.amount)),
    },
    {
      id: "memory",
      say: `${asked.region} has a customer asking for a €${asked.amount} refund for ${asked.what}. Can you approve it?`,
      pass: (reply, memory) =>
        memory.some((line) => /500/.test(line)) &&
        /sign[- ]?off|your (approval|ok|go-ahead|sign)|needs? (you|your)|(check|confirm) with you|you (need|have) to (approve|sign)/i.test(
          reply,
        ),
    },
  ];
}

/**
 * What the digest holds of the work, for each week it covers: how many of its refunds over €500
 * and, from week 3 on, of its chargebacks it names by ticket number.
 */
export function digestHolds(digest, weeks) {
  const named = (list) => list.filter((one) => digest.includes(one.id)).length;
  return weeks.map(({ week, refunds, chargebacks }) => ({
    week,
    refunds: `${named(refunds)}/${refunds.length}`,
    ...(week >= CHARGEBACKS_FROM
      ? { chargebacks: `${named(chargebacks)}/${chargebacks.length}` }
      : {}),
  }));
}
