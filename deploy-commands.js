const credential = require('./var.js');;
const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');

const commands = [
  {
    name: '상태변경',
    description: '장치의 상태를 변경합니다.',
    options: [
        {
            name:'first-number',
            description:'세탁기/건조기의 번호',
            type: ApplicationCommandOptionType.Number,
            required: true
        },
        {
            name:'second-number',
            description:'변경할 세탁기/건조기의 상태',
            type: ApplicationCommandOptionType.Number,
            choices: [
                {
                    name: '작동중',
                    value: 0
                },
                {
                    name: '사용가능',
                    value: 1
                }
            ],
            required: true
        }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(credential.discord_token);

(async () => {
  try {
    console.log('Registering slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(
        credential.discord_clientid,
        credential.discord_guildid
      ),
      { body: commands }
    );

    console.log('Slash commands were registered successfully!');
  } catch (error) {
    console.log(`There was an error: ${error}`);
  }
})();