/**
 * Catálogo de mapas de Age of Empires IV para la interfaz.
 *
 * `Match.map` guarda el nombre visible que publica AoE4World ("Dry Arabia"), pero
 * la miniatura del mapa vive en un fichero con el nombre en minúsculas más un
 * hash de contenido (`dry_arabia-0450...e1532.png`), así que la correspondencia
 * no se puede derivar del nombre y tiene que ser explícita. El hash impide que el
 * juego de imágenes se pueda deducir por reglas: por eso esta lista es de datos,
 * no de código.
 *
 * Se resuelve por nombre y no por un `if` larga lista: un mapa que no esté en el
 * catálogo devuelve `null` y la pantalla cae a un recuadro temático con el nombre
 * escrito, sin romper ni quedarse con un hueco en blanco.
 *
 * Este módulo es de datos puros: lo importa un componente cliente (los filtros de
 * `/partidas`), así que no puede depender de nada `server-only`.
 */

const MAP_IMAGE_DIRECTORY = "/imagenes/mapas";

/** Nombre visible del mapa → fichero de su miniatura en `public/imagenes/mapas`. */
const MAP_FILES: Readonly<Record<string, string>> = {
  "African Waters": "african_waters-6fd00264b0a97fe8acdd8982b9bf95407d332bd03befc7135ed5e50ec2477585.png",
  Altai: "altai-fd8a3e7203b5731d36de7aa73e4a71c473acd34af9119aa7f34f02e4c5f20d89.png",
  "Ancient Spires": "ancient_spires-d314d1fcd47c463c94e8d4a7e0b358eb5771c8e40b2e324943ccfa99103c658c.png",
  Archipelago: "archipelago-3bcd90bcbf0ae196924ea32d2fb3feec8b4236e4e0dfa9f95cd0658e05ed7dac.png",
  Ascension: "ascension-75c9b21c769039843a7248d04e928d4c38d023b6b7e86a271ef1d84457b43703.png",
  Atacama: "atacama-2079706f8cc9a1806e5b7457b251cd7e8b60eb7e02472a0664027ca4f6e64bc9.png",
  Baltic: "baltic-8d5630ac2768fa0c0db75d7b6b4bb27c998aadaaef4920612e971b9a2ad0b6d4.png",
  "Black Forest": "black_forest-b36e64d2c2106a306d5bf6a8ba154d360e1f1dfac9f199297b14a4924eb0e71c.png",
  "Boulder Bay": "boulder_bay-80df21552eb0557cac784d10aff5305f3bbfe42cc6c32a652747966edd384081.png",
  Canal: "canal-11ab0ebadc68ee8903829b57d072ecb42032ab5fde67fcc05e976ab1cbf5a42d.png",
  Canyon: "canyon-d5ec1fd07f07c5cf13cb66fb1d11ad15102668bdd06de8ac823e93362bd360a1.png",
  Carmel: "carmel-78bdc24e1ccb991db6e122afb6f021ab2ffcfc57e6721aaf65533988dfc79213.png",
  Cliffsanity: "cliffsanity-9bd35f847b6c7190966b5e12180c54de899076e8254e1e67f3d62175fdc50d86.png",
  Cliffside: "cliffside-02b81ebe7ca8aae7124a42ecdae93f236d62b7cae3f751ca0e4c5437d3b70afe.png",
  Confluence: "confluence-38415e1f6f5200ac81acda72d0c7277e40013f42933cc8356dccdaff9d522419.png",
  Continental: "continental-7454fffd4e627b4db810724073160f1bdd927c0e560c629e31a3274065c46dda.png",
  Craters: "craters-53111c08cee33ed33ce527acacffbb3d4b04fe0f531eb53b9edecf268f294e77.png",
  "Danube River": "danube_river-ca54b50253cc9656be7f03a83f16b30b91b186ae0f38427cd8d3b3fe3d329b27.png",
  "Dry Arabia": "dry_arabia-045026955a02a077c431b834e14daebd6fc2299de1fc97b9ed102d5e711e1532.png",
  Dungeon: "dungeon-f30e91e334befd45b4bb4001505a9aef3f65d6c04fe3d92ab96fb5379a3f5b01.png",
  "Enlightened Horizon": "enlightened_horizon-34781d4de7032a57264b8688301c843f23ecc579603ddc33f516750a25f7654a.png",
  Fangs: "fangs-68b90b22c328f43cbede6c8bccef411e9aed65ff34b149b81059675ba472c5e7.png",
  Flankwoods: "flankwoods-94f77a90a2e3b8a77e1698d2eb0d29916d03fa1ba110a4c3ab097fe6e1576ec9.png",
  "Forest Ponds": "forest_ponds-251f78780b3deee83db9becc49ba6a63a8927486ed7c36e0e5ad9685899e5aff.png",
  Forts: "forts-46770b9ab10c2ebb50eafa0678cb53bc9aa169719c325334a3d8de883a48846b.png",
  "Four Lakes": "four_lakes-eb90c0b139243782a53f6ce4fb4227d1f6827e9e00672d11a1879a58fa2737aa.png",
  "French Pass": "french_pass-e2050b594942373e219dcbed24e5d882a10c1e5cc51430b035012eec5c77f859.png",
  Glade: "glade-158cc025ccea142d30020d94e38ef780d99a0f5c307e35439d2a1bc607798075.png",
  "Golden Heights": "golden_heights-cbd73e5a06838ba419de8da4981c4333428b5509b7d8f8d7c764f160d614505a.png",
  "Golden Pit": "golden_pit-58ea140f24ea6a779ba831592617f59e317b4b3f5e495ecaa2667fc12fd8e7e0.png",
  Gorge: "gorge-2957c507ddfc9f5dd65204119a742da12c2e29bb6b462537f88dcc624d1a423d.png",
  Haywire: "haywire-a4c3af7b5fd60a3d6101126aede230dee1e18f8900ad6183ac5f375da66c3553.png",
  Hedgemaze: "hedgemaze-34e8d306311f6e0ab43cbcd3c4af2b77a6c99719ae97f8572d8b210b88cf0acc.png",
  "Hidden Valley": "hidden_valley-805beca1bb4e706ca9de9d75f07a8ca031866511f576a5decf70227ba9f6bf29.png",
  Hideout: "hideout-844a7defa35996b750bc7ddd26d0ba0bc3185bc407bfb0f07b3d391982c96471.png",
  "High View": "high_view-cc5dd5d3ce955f188dd6a0dbe6be81dc9d1c0587363d9b1162f0a580eef74340.png",
  Highwoods: "highwoods-1d6f265e447792523bc13610877d5bf7b5cde9a3a198d42931a367113db11786.png",
  "Hill and Dale": "hill_and_dale-2f78aba2ff2a52c12db2ec50951e479812758bc56abe08c232c377f71b507693.png",
  Himeyama: "himeyama-13655082e7f2287fd8dfded1748c36d9a6e2905b9d06171f2f88b9997b1dbc83.png",
  "King of the Hill": "king_of_the_hill-c7a46d265cf7019ef3b74deb5bfd5c74785e245c97ef2846017f5e49b429d687.png",
  Lakeside: "lakeside-49c8b4267fab0c335d28aeff1d73a868587945d252f02f5ebead9c2fd92c2dbf.png",
  "Land MegaRandom": "land_megarandom-1d7b3df69ecd238ae215b6031d92f68659908b4e3f87bdfd85cdd77832c3e5ea.png",
  Lipany: "lipany-5751b94ef86611434be251d256c2e6c2e9e0c5c43ef60d1d10c129e4c09889b2.png",
  Marshland: "marshland-0c8daa2bd2ee7458cfa18ebaccee932dfe5f5fc69e7c6ab17b6ebf6d7e913b1f.png",
  MegaRandom: "megarandom-164c04761154526a883de15a40c78a6200d89fe178da24ea2a948f8ef3712383.png",
  Michi: "michi-b1d9e054c815f9d0dfdcfc49bdadd586001addf541b65ba410712e5566cd17af.png",
  Migration: "migration-858695ce51bfcf37e5ca182490587542a139cc2ddfe4d898bc86116039b5109a.png",
  "Mongolian Heights": "mongolian_heights-ec78442d7b558b2eee4d38f362ae6749ffbb00f3eadc66921496f769b3de00ca.png",
  "Mountain Clearing": "mountain_clearing-9cbb1edfab71618b0ba2af4b428cd57b02dc90f460063c161dba4563862da587.png",
  "Mountain Lakes": "mountain_lakes-db31402c2af3b74432080b077d32d837d8b6e96295ca09d5db576ab1d78678b0.png",
  "Mountain Pass": "mountain_pass-8ecaa91d1bdb997eedde1c50c6f0e4186f6cd98babb5ab64d10ca789be2df7ec.png",
  Nagari: "nagari-dfc402256a571f808629ae663a37b2da5af7cbbebe8d3869818550f8f4adba82.png",
  "Nomadic Ridges": "nomadic_ridges-0829919f0729aedba28e9fcd26b68a39e8f9b88d68750ba646d92d08d2570df0.png",
  "Nomadic Tarns": "nomadic_tarns-e0348c37bcf87f818a98ef794019f078262275c89772fcfb8cc631093a38f6fa.png",
  Oasis: "oasis-83779e586093cf624f6bfa705eb809da9e49b54f99ba6b37e980c82978e4224c.png",
  "Ocean Gateway": "ocean_gateway-c8c38f657a77ff02ea419e626a1f8aed59e8b8c72b913fd9f6809bc5325281b9.png",
  Prairie: "prairie-4019a464af9a1ef8ae866ff607cedfa683889afaf2542bf16dd48c3a9295dcb5.png",
  "Relic River": "relic_river-691237e37dc0ab45b9462b29f6661b4540c899baa4601bac41f692cfec889a10.png",
  "Rocky River": "rocky_river-b89f84bf6594d401f8c3b3aa2ca4e84bbdd2204047ea84d8d0ee4a46348d6cf2.png",
  Rugged: "rugged-b1393575c8bcae737ef08569e2b68897d4626bccc07143bbf113cee7dacc59ab.png",
  "Shadow Lake": "shadow_lake-92b93c5dc523f4e97a41aed3ea8f6bce2b9c4b2515ab726acd577fa18d679c56.png",
  "Snake River": "snake_river-0beaf1431790bd106dc5c98a6aface5cb66521018026709dc4776c6ff4ee7db8.png",
  Socotra: "socotra-6cd38407b889d5f6b03b3504635e858abfb249ef659df1b8d71c8f88e5ff6fb2.png",
  Sunkenlands: "sunkenlands-2cb6fccb7a7532991354b7f4145494efdd581671409ec5203239146b6a71e5ba.png",
  "The Pit": "the_pit-f4c40bd5fb1cf5740f0692e3e4b46743ee27ce02765ba27143bc918a97974b8c.png",
  Thickets: "thickets-a6170dc0d98a05e30cb25b2f0a56d1d1ba3f604c0ebd008e1301289f3b1ffbe5.png",
  "Turtle Ridge": "turtle_ridge-ec0639f315c99c9a69a540ba9d63e3551408af0809e6d4ea50af07492a325c83.png",
  "Volcanic Island": "volcanic_island-240c6f45fbc22192893176eb672fb88d40ab84ea6ce70ada8ede587add015fe5.png",
  "Warring Islands": "warring_islands-b83aaad48a92886537baecc4af87316ae59926881b8ec9397375c83a0c4d48e4.png",
  Wasteland: "wasteland-35843249b21260d26ae682b58248ee902d5b19e9d1cb5975567b6d0a533dbb4d.png",
  Waterholes: "waterholes-963431442e462e2f4607e3b7c902f8057b31fdc857e4ce60d992b881be46d2e9.png",
  Waterlanes: "waterlanes-278d516946d4496c7b09739a9e3e63360beb87903a5c97c81e197d1cff77d163.png",
  "West Lake": "west_lake-50b7e4a559a5be9998f145388bceb83129e9c6eedfc0d2738633346f215bd79f.png",
  Wetlands: "wetlands-d2ccdd59c13238cf9f17fef6b8825bed78cf22cdc8fe8d8d78f985b7b1a1548f.png",
};

/** Clave tolerante: el nombre llega de la API y puede variar en espacios o caja. */
function mapKey(name: string): string {
  return name.trim().toLowerCase();
}

const FILE_BY_KEY = new Map<string, string>(
  Object.entries(MAP_FILES).map(([name, file]) => [mapKey(name), file]),
);

/**
 * Ruta pública de la miniatura de un mapa, o `null` si el catálogo no lo conoce.
 *
 * `null` también para un mapa sin nombre: quien pinta decide qué recuadro de
 * reserva enseñar, y para eso solo necesita saber que no hay imagen.
 */
export function mapImage(name: string | null | undefined): string | null {
  if (name === null || name === undefined) {
    return null;
  }

  const file = FILE_BY_KEY.get(mapKey(name));

  return file === undefined ? null : `${MAP_IMAGE_DIRECTORY}/${file}`;
}
