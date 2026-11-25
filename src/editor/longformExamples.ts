// What the Longform dialog and the AI agents panel show people to start from:
// a short script per format, and prompts for an agent that writes the script too.
// Pure text, so the tests can check every example still parses.

/** A short script per format (LONGFORM_FORMATS ids), written the way that format's tip asks. */
export const LONGFORM_EXAMPLES: Record<string, string> = {
  explainer: `# How bees find flowers
*What a hive knows that we don't*

A bee can find a flower two miles away and tell the whole hive where it is. Here is how.

## What bees see
Bees see ultraviolet light. Many flowers carry marks in it that we cannot see, pointing straight at the nectar.
- Ultraviolet marks
- Invisible to us

## The waggle dance
Back in the hive, the bee dances. The angle of the dance is the direction, measured against the sun. Its length is the distance.
- Angle is direction
- Length is distance

## Outro
That is how a hive finds its flowers. Thanks for watching.
`,
  documentary: `# Apollo 13
*The failure that became a rescue*

Two hundred thousand miles from Earth, an oxygen tank exploded. Three astronauts had to get home in a ship that was dying.

## The explosion
On April 13, 1970, the crew heard a loud bang. Suddenly the power was falling and oxygen was leaking into space. The Moon landing was gone.

## The lifeboat
Mission control had to think fast. The crew moved into the lunar lander, a craft built to keep two men alive for two days. Now it had to carry three men for nearly four.

## The fix
The air was turning toxic. Engineers on the ground built a filter from tape, cardboard, a plastic bag and a hose, then read the steps to the crew. It worked.

## Outro
On April 17, all three splashed down alive. Thanks for watching.
`,
  'video-essay': `# Why we love bad movies
*In defence of the terrible*

Some films fail at everything, and we watch them again and again. Why do we love something so wrong?

## Failure is honest
A bad movie cannot hide. You see every mistake, and behind each one, someone who tried. That is rare, and it is oddly moving.

## We laugh together
Nobody watches a disaster alone. You call your friends, you quote the worst lines, and the whole room laughs. The film is terrible. The night is perfect.

## Outro
Maybe great art is admired, and bad art is loved. Thanks for watching.
`,
  listicle: `# Three habits that ruin your morning
*Counted down to the worst*

Most bad days are decided before nine. Here are three habits that do it, from bad to worst.

## The snooze button
Nine more minutes of sleep feels like a gift. Then the alarm rings again, and you are more tired than the first time.
- Get up on the first alarm

## Email before breakfast
You open your laptop to check one message. Forty minutes later you are still typing, and still hungry.
- One message is never one message

## Your phone in bed
You reach for your phone before your eyes are open. The scrolling starts, and the morning is gone.
- Leave it across the room

## Outro
Fix number one first. Thanks for watching.
`,
  tutorial: `# How to make pour-over coffee
*One cup, four minutes*

By the end of this video you will have made a clean, bright cup of coffee with nothing but a filter and a kettle.

## Heat the water
Boil the water, then wait thirty seconds. Water that is too hot makes coffee taste bitter.
- Just off the boil

## Let it bloom
Pour in a little water, just enough to wet the grounds, then wait thirty seconds. This first pour is called the bloom.
- Wet the grounds, then wait

## Pour slowly
Now pour the rest in slow circles, from the middle out. When the dripping stops, you are finished. Great coffee, every time.
- Slow circles, middle out

## Outro
That is all there is to it. Thanks for watching.
`,
  lecture: `# How compound interest works
*Money that earns money*

This lesson covers what compound interest is and why time matters more than the amount. It is for anyone who was never taught it.

## Interest on interest
Simple interest pays you on what you put in. Compound interest pays you on what you put in, plus everything it has already earned.
- Simple: paid on the deposit
- Compound: paid on the growing total

## The rule of 72
Divide seventy-two by the interest rate, and you get the years it takes to double. At six percent, your money doubles in twelve years.
- 72 ÷ rate = years to double
- 6% doubles in 12 years

## Why starting early wins
Think of two savers who put away the same amount every month. The first starts at twenty-five, the second at thirty-five. At seven percent a year, the first one retires with about twice as much.
- Ten years early, about double

## Outro
Start small, and start now. Thanks for watching.
`,
  'product-walkthrough': `# Meet Acme Notes
*Notes that find themselves*

You wrote it down somewhere. Now you need it, and you cannot remember where. Here is a notes app built for exactly that moment.

## Find any note in a second
Type a few words into the search box. Acme looks through every note you have ever written, and shows the right one before you finish typing.
- Search as you type

## Keep everything private
Your notes stay on your own device. Nothing is uploaded, and nobody else can read them.
- Stored on your device

## Share with one link
When you do want to share a note, press one button and send the link.
- One button to share

## Outro
Try it yourself. The link is in the description.
`,
  comparison: `# Paper vs Screen
*Which is better for reading?*

You read every day, on paper and on a screen. Let us compare them, round by round.

## Focus
Winner: Paper
A book does one thing. A screen offers messages, tabs and alerts while you read. For staying on the page, paper wins.
- Paper: nothing else to tap

## Convenience
Winner: Screen
A screen holds a whole library in your pocket, and lights itself at night. For carrying and finding books, the screen wins.
- Screen: a library in your pocket

## Memory
Winner: Paper
Many readers find it easier to remember where something was on a printed page, because the page has a place you can feel.

## Outro
Use paper to study, and a screen to travel. Thanks for watching.
`,
  'news-recap': `# The week on Maple Street
*An example roundup: swap in your own stories*

Three stories this week. The bakery has a new owner, the bridge is open again, and the library stays open late.

## The bakery has a new owner
After thirty years, the corner bakery changed hands on Monday. The new owner says the bread recipe stays exactly the same.

## The bridge is open again
The footbridge reopened on Wednesday, two weeks ahead of schedule. Walkers and cyclists can cross the river again.

## The library stays open late
Starting Friday, the library closes at nine instead of six. Longer evenings were the most common request this year.

## Outro
That is the roundup for this week. See you next time.
`,
  'data-story': `# Water, by the numbers
*Three figures about a blue planet*

From space, Earth is blue. But almost none of that water is water we can drink. Three numbers explain why.

## Of the surface is water
Figure: 71%
Oceans, seas, lakes and ice cover about seventy-one percent of the planet. Land is the smaller part.

## Of that water is salty
Figure: 97%
About ninety-seven percent of all the water on Earth is in the oceans, too salty to drink or to grow food with.

## Is fresh water within reach
Figure: under 1%
Most fresh water is locked in ice, or lies deep underground. Less than one percent of all water is in the rivers and lakes we can use.

## Outro
A blue planet, with very little to drink. Thanks for watching.
`,
  timeline: `# From the first flight to the Moon
*Sixty-six years*

In a single lifetime, people went from never having flown to walking on the Moon. Here is how fast it happened.

## The first flight
Date: 1903
On a cold December morning, the Wright brothers flew for twelve seconds. It was the first powered flight in an aeroplane.

## Across the ocean
Date: 1927
Charles Lindbergh flew alone from New York to Paris without stopping. It took him more than thirty-three hours.

## On the Moon
Date: 1969
Neil Armstrong stepped onto the Moon while the world watched. The first flight was only sixty-six years earlier.

## Outro
Twelve seconds in the air, then the Moon, in one lifetime. Thanks for watching.
`,
  podcast: `# Why do we yawn?
*A short conversation*

Maya: Tom, you just yawned. Now I have to yawn too. Why does that happen?

Tom: Nobody is completely sure. But there are some good ideas.

## What a yawn does
Maya: So what is a yawn for?

Tom: One idea is that it cools the brain. You pull in a big breath of air, and your jaw stretches wide.

Maya: Like opening a window.

## Why it spreads
Tom: Seeing a yawn makes many people yawn. Even reading about one can do it.

Maya: I am trying very hard not to yawn right now.

## Outro
Maya: So a yawn is still a small mystery. Thanks for listening.
`,
  commentary: `# The front row is the worst seat
*A short commentary*

Everyone fights for the front row. I think it is the worst seat in the room, and I can tell you why.

## You see less
From the front you look up at the screen, and you miss the edges. Sit in the middle, and the whole picture fits in your eyes.
- The middle sees everything

## You hear less
The sound is tuned for the centre of the room. In the front, the voices come from above you, and the music from behind.
- Sound is mixed for the middle

## Outro
So next time, let them have the front row. What do you think?
`,
  'comic-story': `# The day the wifi died
*A short story in panels*

It was nine in the morning. The wifi was gone. Nobody was ready.

## The panic
Sam ran to the router and stared at it. He turned it off and on again. Nothing happened. He called his sister on the phone. She laughed at him.

## The long afternoon
With nothing to scroll, Sam sat down and started thinking. He found an old book and read the first page. Then he fell asleep in the chair, and the whole afternoon went by without him, quietly, one slow hour after another.

## Outro
At six the wifi came back. Sam did not notice until the next morning. What a great day.
`,
  trailer: `# Acme Notes
*Notes that find themselves*

You wrote it down somewhere. Now you need it.

## Find any note in a second
Search as you type, across everything you ever wrote.
- Search as you type
- Every note, every word

## Private by design
Your notes never leave your device.
- Stored on your device
- No account needed

## Share with one link
One button, one link, done.

## Outro
Try it free at acmenotes.example
`,
  quiz: `# How well do you know the solar system?
*Three questions, five seconds each*

Three questions about our solar system. You get five seconds for each one. Keep count of your score.

## Which planet is closest to the Sun?
- Venus
- Mercury
- Mars
- Earth
Answer: Mercury
Mercury circles the Sun in just eighty-eight days.

## How many planets are in the solar system?
- Seven
- Eight
- Nine
Answer: Eight
There are eight. Pluto was renamed a dwarf planet in 2006.

## Which planet has the most mass?
- Saturn
- Neptune
- Jupiter
- Uranus
Answer: Jupiter
Jupiter has more mass than all the other planets put together.

## Outro
How many did you get? Tell us in the comments.
`,
};

/**
 * A prompt for a connected agent that writes the script itself and builds the
 * whole video. `[your topic]` is the one thing the user fills in.
 */
export function agentPrompt(formatName: string, artName?: string): string {
  const kind = formatName.toLowerCase();
  // A trailer is about a product and runs under a minute; a quiz is counted in questions.
  if (/trailer/.test(kind)) return 'Use krypt-editor to make a 45-second trailer for [your product and where it lives: a website or an app]. Read what it really does first, film its main features yourself, and build it cut to the beat. Then show me a few frames.';
  if (/quiz/.test(kind)) return 'Use krypt-editor to make a 10-question quiz about [your topic], the easy questions first. Check every answer, build it, look at a few frames, and give me the answers as a list.';
  return `Use krypt-editor to make a 5-minute ${kind} about [your topic]${artName ? `, drawn in the ${artName} style` : ''}. Write the script yourself, build it with captions, look at a few frames to check it, and give me the chapter list.`;
}

/** Prompts the AI agents panel offers: a whole video from one sentence, no footage needed. */
export const AGENT_VIDEO_PROMPTS: string[] = [
  'Use krypt-editor to make a 5-minute stickman explainer about why we procrastinate. Write the script yourself and add captions.',
  'Make a top 5 list of the strangest deep-sea animals as a 3D cartoon video, then export it to my Desktop.',
  'Turn these notes into a chalkboard lecture with key points and chapters: [paste your notes]',
  'Tell the story of [what happened] as a stickman comic story: short sentences, a panel each, speech bubbles where someone talks. Then make three thumbnails for it to choose from.',
  'Make a 10-question quiz about [your topic] with a 5-second countdown, the easy questions first. Check every answer before you build it.',
];

/** Prompts where the agent gets the footage too: it films a product for a trailer, works from a recording, draws the panels, films a web page, records an app window, or finds photographs itself. */
export const AGENT_CAPTURE_PROMPTS: string[] = [
  'Make a 45-second trailer for [your product] from its website [link]: read what it does, film its three best features yourself, and cut it to the beat with an end card that says where to get it.',
  'Turn this recording into a video: [path to a podcast episode, a talk or a voice memo]. Listen to it, pick the chapters, add key points and pictures, keep my own voice, and give me the chapter list.',
  'Tell the story of [what happened] as a comic and draw every panel yourself: a drawing for every sentence or two, the same stick-figure character throughout, and tag the parts that should move. Show me the panels before you build the video.',
  'Use krypt-editor to film a walkthrough of [your website]: open it, click through its three main features, then build a product walkthrough with a voice-over and captions.',
  'Make a "[X] vs [Y]" comparison video: film both websites yourself, put them side by side round by round, and tell me who wins.',
  'Record the [app name] window for 20 seconds while I use it, then turn it into a product demo with zooms on my clicks.',
  'Make a 4-minute documentary about Mount Etna with real photographs: find the pictures yourself, and give me the chapters and the picture credits for the description.',
  'Study the YouTube channel [channel link] and make a video about [your topic] packaged the way they do it: a title in their shape, a thumbnail in their colours, chapters in the description. Do not copy anything of theirs.',
];
