// Short, easy-to-type words for the family passphrase (256 words = 8 bits each).
export const WORDS = `acorn amber anchor apple arrow aspen atlas autumn badge bagel bamboo banjo barley basil beacon beagle
berry birch bison blanket blossom bluff bonfire booth bramble breeze brick bridge brook bucket buffalo bugle cabin cactus
camel candle canoe canyon carrot castle cedar cello chalk cherry chess cider cinder clover cobalt comet copper coral cotton
cowboy coyote crane creek cricket crystal cypress daisy dawn delta desert dingo dolphin dove dragon drum eagle echo elk
ember falcon feather fern fiddle finch fjord flame flint forest fossil fox galaxy garden garnet gecko geyser ginger glacier
granite grape gravel grove gull harbor hawk hazel heron hickory honey horizon husky iguana indigo iris island ivory jade
jaguar jasper jelly juniper kayak kettle kiwi koala lagoon lantern larch lark laurel lemon lilac lily lime linen lizard
llama lotus lynx magnet mango maple marble marsh meadow melon mesa mint moose moss muffin mustang nectar nickel nutmeg oak
oasis ocean olive onyx orchid osprey otter owl oyster paddle panda papaya parrot peach pebble pecan pepper pine piano plum
pony poppy prairie puffin pumpkin quail quartz quilt rabbit radish rain raven reef ridge river robin rocket rose ruby sage
salmon sandal saddle sequoia shadow shell sierra silver sky slate sparrow spruce squash stone summit sunset swan tango
thistle thunder tiger timber tulip tundra turtle valley velvet violet walnut walrus willow wind wolf wren yarrow zebra
zephyr acre aloe apron bacon banner barn beaver beet biscuit blaze boot bramble2 bronze butter cabbage camp canary`
  .split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
