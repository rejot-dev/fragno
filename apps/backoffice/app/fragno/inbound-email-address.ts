function words(list: string): readonly string[] {
  return list.trim().split(/\s+/u);
}

/**
 * Words people read, say, and type back, so none is crude, morbid, or a slur beside an animal, none
 * sounds like another word, and none has a second accepted spelling.
 */
const ADJECTIVES = words(`
  able agile alert amber ample apt arctic ardent artful astute avid azure beaming blissful bouncy
  brainy brave breezy bright bubbly busy calm candid caring casual cheery chipper civil clever
  cloudy coastal cobalt comfy cosmic crafty crimson crisp cuddly curious curly dainty dandy daring
  dapper dashing dazzling deft devoted dewy diligent dreamy dusty dynamic eager earnest earthy
  eastern elated electric elegant emerald epic even exact fabled famous fancy fearless feisty
  festive fine fluffy fluent fond frank fresh friendly frosty frugal fuzzy gallant gentle genuine
  gifted giddy gilded glad glassy gleaming glossy glowing golden graceful grand grateful gusty happy
  hardy hearty helpful hidden honest hopeful humble icy ideal indigo inky jade jaunty jazzy jolly
  jovial joyful jubilant jumbo jumpy keen kind kindly kinetic lavish leafy lemon level lilac limber
  lively lofty loyal lucid lucky lunar magic majestic mellow merry mighty mild minty misty modest
  mossy musical mystic nautical neat nifty nimble noble nordic northern novel oaken olive opal open
  orange orderly patient peachy pearly pebbly peppy placid playful plucky plush polar polished
  polite prime proper proud prudent punctual purple quaint quick quiet quirky radiant rainy rapid
  rare ready regal relaxed robust rocky rosy royal ruby rugged rusty rustic saffron sage salty sandy
  scarlet scenic serene sharp shiny silent silky silver sincere sleek sleepy smart smoky smooth
  snappy snowy snug social solar solid sonic southern sparkly speedy spiral spirited splendid
  spotted spry starry steady stellar stormy striped sturdy sublime sugary sunlit sunny super supple
  swift tactful tall tangy teal tender thrifty tidal tidy timely tiny toasty tranquil tropical
  trusty twinkly upbeat upright urban valiant vast velvet verdant vibrant vintage violet vivid warm
  wavy western wild windy wintry wise witty wooden zany zesty zigzag zippy
`);

const ANIMALS = words(`
  aardvark albatross alpaca anteater antelope armadillo badger barracuda beagle beaver beetle beluga
  bison bobcat buffalo bumblebee butterfly camel canary capybara cardinal caribou catfish chameleon
  cheetah chickadee chipmunk cicada clownfish cobra collie condor corgi cougar coyote crab crane
  cricket crow curlew dingo dolphin donkey dormouse dove dragonfly duck duckling dugong eagle egret
  eland elephant elk emu falcon ferret finch firefly flamingo foal fox frog gazelle gecko gerbil
  giraffe goat goldfish goose gopher gosling gull hamster hawk hedgehog heron hippo hornet ibis
  iguana impala jackal jaguar jay jellyfish kangaroo kestrel kitten kiwi koala kudu lamb lark
  lemming lemur leopard lion lizard llama lobster macaw magpie mallard manatee mantis marlin marmot
  meerkat minnow mink mongoose moth mule narwhal newt nightjar ocelot octopus orca oriole osprey
  ostrich otter owl oyster panda pangolin panther parrot partridge pelican penguin petrel pigeon
  piglet pika platypus plover pony poodle porcupine puffin puma puppy python quail quokka rabbit
  raven reindeer robin sable salmon sandpiper sardine seahorse seal serval shark sheep shrimp sloth
  snail sparrow squid starfish stingray stoat stork swan tapir tiger toad toucan trout tuna turtle
  viper vole wallaby walrus warbler wombat wren yak zebra
`);

/** A uniform index below `length`; the modulo bias over 2^32 values is far below what matters here. */
function randomIndex(length: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % length;
}

/**
 * A local part such as `quiet-amber-falcon`: two different adjectives and an animal, about 24 bits.
 * An address only lets someone send to it, so the words need to stop guessing, not keep secrets.
 */
function generateLocalPart(): string {
  const first = randomIndex(ADJECTIVES.length);
  // Draws from the adjectives after `first`, wrapping around, so the two are never the same.
  const second = (first + 1 + randomIndex(ADJECTIVES.length - 1)) % ADJECTIVES.length;
  return `${ADJECTIVES[first]}-${ADJECTIVES[second]}-${ANIMALS[randomIndex(ANIMALS.length)]}`;
}

/** Collisions are rare, so running out of draws means the generator or registry is broken. */
const MAX_ADDRESS_DRAWS = 5;

/** Offers random addresses at `domain` to `claim` until it gets one that was never issued. */
export async function claimRandomInboundAddress<TResult extends { status: string }>(
  domain: string,
  claim: (address: string) => Promise<TResult>,
): Promise<Exclude<TResult, { status: "taken" }>> {
  for (let draw = 0; draw < MAX_ADDRESS_DRAWS; draw++) {
    const result = await claim(`${generateLocalPart()}@${domain}`);
    if (result.status !== "taken") {
      return result as Exclude<TResult, { status: "taken" }>;
    }
  }
  throw new Error(`No unissued inbound address at ${domain} after ${MAX_ADDRESS_DRAWS} draws.`);
}
