// The names an agent is offered: short, plain given names, enough of them that a row of new agents
// never runs out. A name is also its workspace's folder, so each is letters alone.

export const NAMES = `
Scout Wren Juniper Cedar Maple Sage Abby Ada Adam Aiden Aiko Akira Alba Alec Alex Alice Alma
Amara Amber Amir Amy Andre Andy Anika Anna Anton Anya Archie Ari Aria Arlo Arthur Asha Asher Ash
Astrid Aurora Ava Axel Ayla Bea Beau Bella Ben Benji Beth Bianca Blake Bo Bodhi Bram Bree Brook
Bruno Bryn Cal Callum Cara Carl Carmen Casey Cass Chloe Clara Clark Cleo Clive Cody Cole Cora
Cruz Cyrus Dahlia Daisy Dale Dana Dane Dani Dara Daria Dawn Dean Delia Demi Devi Devon Dex Diana
Diego Dina Dora Drew Dylan Eamon Eden Edie Edith Eli Elias Elio Ella Ellis Elsa Ema Emil Emma
Enzo Eric Erin Esme Ethan Etta Eva Evan Ezra Fay Felix Fern Finn Fiona Flora Flynn Ford Fran
Freya Frida Gabe Gaia Gemma Gia Gigi Gil Gina Gio Grace Greta Gus Gwen Hale Hana Hank Hari
Harper Hattie Hazel Heidi Henry Hugo Hye Ian Ida Idris Iggy Ike Ilsa Iman Imani Ines Ingrid Ira
Iris Isaac Isla Ivan Ivo Ivy Izzy Jack Jade Jai Jake Jamie Jana Jane Jasper Jay Jean Jem Jess
Jett Jia Jin Joan Joe Joel Jonah Jude Jules Julia June Juno Kai Kaia Kala Kara Karim Kate Kaya
Keiko Ken Kenji Kian Kiko Kim Kira Kit Knox Koa Kofi Kyra Lana Lane Lara Lars Layla Lea Leah
Leif Leila Lena Leo Leon Levi Lia Liam Lila Lily Lin Lina Linus Liv Logan Lola Lotte Lou Luca
Lucy Luis Luka Luna Lyra Mabel Maeve Maia Malia Malik Mara Marco Mari Mark Marlo Max Maya Meg
Mei Mia Micah Mika Mila Miles Milo Mina Mira Moe Mona Moss Musa Myra Nadia Naomi Nate Navi Neil
Nell Nia Nico Niko Nila Nina Noa Noah Noel Nola Nora Nova Nuri Odin Olga Olive Ollie Omar Onyx
Opal Ori Orla Oscar Otis Otto Owen Pablo Paige Pax Pearl Penny Perry Petra Pia Piper Polly Poppy
Priya Quinn Rae Rafa Rami Rana Ravi Ray Reese Remy Rena Rex Rhea Ria Rio Rita Robin Rohan Roma
Ronan Rory Rosa Rose Ross Rowan Roy Ruby Rudy Rue Rufus Ruth Ryan Sadie Saga Sam Sana Sara Sasha
Saul Sean Selma Seth Shay Shea Sid Siena Silas Simon Sky Sol Sonia Sora Stella Suki Sunny Tala
Talia Tamar Tara Tate Teo Tess Thea Theo Tia Tilda Tina Tobi Toby Tomas Toni Tori Troy Tula Tyra
Uma Una Uri Vada Val Vera Vic Vida Viggo Vince Viola Vita Vivi Wade Walt Wes Will Willa Wim
Winnie Wyatt Xander Xena Yael Yara Yuki Yuna Yuri Yusuf Zac Zadie Zane Zara Zeke Zelda Zia Zoe
Zola Zora Zuri
`
  .trim()
  .split(/\s+/);

/**
 * A name from the list that nothing in `taken` is, in any case: a folder's name is one in any
 * case. Chosen by `random`, a number from 0 to 1. None when every name is taken.
 */
export function freshName(taken: Iterable<string>, random: () => number = Math.random): string {
  const had = new Set([...taken].map((name) => name.toLowerCase()));
  const free = NAMES.filter((name) => !had.has(name.toLowerCase()));
  return free[Math.floor(random() * free.length)] ?? "";
}
