(function initRoleRegistry(root, factory) {
    const registry = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = registry;
    } else {
        root.WerewolfRoles = registry;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRoleRegistry() {
    const roles = [
        {
            id: 'VILLAGER',
            settingsKey: 'villager',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Dân Làng',
            color: 'var(--text)',
            description: 'Phe Dân Làng. Bạn không có kỹ năng ban đêm. Hãy quan sát, suy luận và dùng lá phiếu ban ngày để tìm ra Ma Sói.'
        },
        {
            id: 'AURA_SEER',
            settingsKey: 'aura_seer',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Tiên Tri Hào Quang',
            color: '#8c52ff',
            description: 'Phe Dân Làng. Mỗi đêm, bạn chọn 1 người để soi hào quang, biết người đó thuộc nhóm Tốt, Xấu hoặc Không xác định.'
        },
        {
            id: 'DOCTOR',
            settingsKey: 'doctor',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Bác Sĩ',
            color: '#2ecc71',
            description: 'Phe Dân Làng. Mỗi đêm, bạn chọn 1 người để bảo vệ khỏi Ma Sói. Không thể bảo vệ cùng một người trong 2 đêm liên tiếp.'
        },
        {
            id: 'WITCH',
            settingsKey: 'witch',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Phù Thủy',
            color: '#9b59b6',
            description: 'Phe Dân Làng. Bạn có 2 bình thuốc: 1 bình cứu người bị Sói cắn và 1 bình độc để giết 1 người. Mỗi bình chỉ dùng được 1 lần.'
        },
        {
            id: 'PRIEST',
            settingsKey: 'priest',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Linh Mục',
            color: '#00bcd4',
            description: 'Phe Dân Làng. Một lần vào ban ngày, bạn có thể tạt nước thánh vào 1 người. Nếu người đó là Sói, họ chết. Nếu không phải Sói, bạn chết.'
        },
        {
            id: 'RED_LADY',
            settingsKey: 'red_lady',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Gái Điếm',
            color: '#e11d48',
            description: 'Phe Dân Làng. Mỗi đêm, bạn có thể ghé thăm 1 người. Nếu bị tấn công khi đang ghé thăm, bạn không chết. Nếu ghé thăm người bị tấn công, Ma Sói hoặc sát thủ đơn độc, bạn chết.'
        },
        {
            id: 'LOUDMOUTH',
            settingsKey: 'loudmouth',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Bé Mồm Bự',
            color: '#f59e0b',
            description: 'Phe Dân Làng. Bạn có thể chọn 1 người. Khi bạn chết, vai trò của người đó sẽ bị tiết lộ cho tất cả mọi người.'
        },
        {
            id: 'MAID',
            settingsKey: 'maid',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Hầu Gái',
            color: '#14b8a6',
            description: 'Phe Dân Làng. Mỗi đêm, bạn chọn 1 người để bảo vệ. Nếu người đó bị tấn công, họ sống sót và bạn chết thay. Bạn cũng tự bảo vệ bản thân trước đòn tấn công đầu tiên mỗi đêm.'
        },
        {
            id: 'AVENGER',
            settingsKey: 'avenger',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Kẻ Báo Thù',
            color: '#ef4444',
            description: 'Phe Dân Làng. Bạn có thể chọn 1 người làm mục tiêu báo thù. Nếu bạn chết sau đêm đầu tiên, người đó sẽ chết cùng bạn.'
        },
        {
            id: 'MAYOR',
            settingsKey: 'mayor',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Thị Trưởng',
            color: '#facc15',
            description: 'Phe Dân Làng. Ban ngày, bạn có thể tự lộ vai trò cho cả làng. Sau khi lộ, phiếu treo cổ của bạn được tính là 2 phiếu trong phần còn lại của ván.'
        },
        {
            id: 'JAILER',
            settingsKey: 'jailer',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Giám Ngục',
            color: '#64748b',
            description: 'Phe Dân Làng. Ban ngày, bạn chọn 1 người để giam vào đêm kế tiếp. Ban đêm, bạn nói chuyện ẩn danh với người bị giam. Người bị giam không thể dùng kỹ năng hoặc bị tấn công. Bạn có 1 viên đạn để xử tử người bị giam.'
        },
        {
            id: 'MEDIUM',
            settingsKey: 'medium',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Đồng Cốt',
            color: '#38bdf8',
            description: 'Phe Dân Làng. Ban đêm, bạn có thể nói chuyện ẩn danh với người đã chết và xem tin nhắn của chat hồn ma trong đêm.'
        },
        {
            id: 'SHERIFF',
            settingsKey: 'sheriff',
            team: 'VILLAGE',
            alignment: 'GOOD',
            hasNightAction: true,
            name: 'Cảnh Sát Trưởng',
            color: '#0ea5e9',
            description: 'Phe Dân Làng. Mỗi đêm, bạn chọn tối đa 2 người để theo dõi. Nếu một người bị theo dõi chết trực tiếp trong đêm, bạn nhận 2 nghi phạm có thể đã gây ra cái chết đó.'
        },
        {
            id: 'FLOWER_CHILD',
            settingsKey: 'flower_child',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Đứa Trẻ Hoa',
            color: '#ec4899',
            description: 'Phe Dân Làng. Một lần mỗi ván vào ban ngày, bạn có thể bảo vệ 1 người khỏi bị cả làng treo cổ trong lượt bỏ phiếu hôm đó.'
        },
        {
            id: 'CURSED',
            settingsKey: 'cursed',
            team: 'VILLAGE',
            alignment: 'GOOD',
            name: 'Người Bị Nguyền',
            color: '#a3e635',
            description: 'Phe Dân Làng khi bắt đầu. Nếu bị Ma Sói tấn công, bạn không chết mà biến thành Ma Sói thường và từ đó thắng với phe Sói.'
        },
        {
            id: 'WEREWOLF',
            settingsKey: 'werewolf',
            team: 'WEREWOLF',
            alignment: 'EVIL',
            isWolfRole: true,
            hasNightAction: true,
            name: 'Ma Sói',
            color: 'var(--wolf-red)',
            description: 'Phe Ma Sói. Mỗi đêm, bạn cùng bầy sói chọn 1 người để cắn. Mục tiêu của phe Sói là tiêu diệt hết Dân Làng và các phe đối địch.'
        },
        {
            id: 'NIGHTMARE_WEREWOLF',
            settingsKey: 'nightmare_werewolf',
            team: 'WEREWOLF',
            alignment: 'EVIL',
            isWolfRole: true,
            hasNightAction: true,
            name: 'Sói Ác Mộng',
            color: 'var(--wolf-red)',
            description: 'Phe Ma Sói. Ban ngày, bạn có thể ru ngủ 1 người, khiến họ không thể dùng kỹ năng vào đêm kế tiếp. Kỹ năng này dùng tối đa 2 lần.'
        },
        {
            id: 'WOLF_SEER',
            settingsKey: 'wolf_seer',
            team: 'WEREWOLF',
            alignment: 'EVIL',
            isWolfRole: true,
            hasNightAction: true,
            name: 'Sói Tiên Tri',
            color: 'var(--wolf-red)',
            description: 'Phe Ma Sói. Mỗi đêm, bạn có thể soi chính xác vai trò của 1 người. Nếu muốn tham gia cắn cùng bầy Sói, bạn phải bỏ lượt soi.'
        },
        {
            id: 'CURSED_WOLF',
            settingsKey: 'cursed_wolf',
            team: 'WEREWOLF',
            alignment: 'EVIL',
            isWolfRole: true,
            hasNightAction: true,
            name: 'Sói Nguyền',
            color: 'var(--wolf-red)',
            description: 'Phe Ma Sói. Một lần mỗi ván, bạn có thể nguyền rủa 1 người. Người đó sẽ biến thành Sói vào sáng hôm sau.'
        },
        {
            id: 'GUARDIAN_WOLF',
            settingsKey: 'guardian_wolf',
            team: 'WEREWOLF',
            alignment: 'EVIL',
            isWolfRole: true,
            hasNightAction: true,
            name: 'Sói Hộ Vệ',
            color: 'var(--wolf-red)',
            description: 'Phe Ma Sói. Ban đêm, bạn nói chuyện và vote cắn cùng bầy Sói. Ban ngày, bạn có thể chọn 1 người để bảo vệ khỏi bị treo cổ; nếu bảo vệ thành công, kỹ năng sẽ bị tiêu hao.'
        },
        {
            id: 'ARSONIST',
            settingsKey: 'arsonist',
            team: 'ARSONIST',
            alignment: 'UNKNOWN',
            hasNightAction: true,
            name: 'Kẻ Phóng Hỏa',
            color: '#ff5722',
            description: 'Phe Thứ 3. Mỗi đêm, bạn có thể tưới xăng lên tối đa 2 người. Bạn có 1 lần châm lửa để thiêu toàn bộ những người đã bị tưới xăng.'
        },
        {
            id: 'FOOL',
            settingsKey: 'fool',
            team: 'FOOL',
            alignment: 'UNKNOWN',
            name: 'Kẻ Ngốc',
            color: '#e67e22',
            description: 'Phe Thứ 3. Bạn thắng nếu bị Dân Làng treo cổ vào ban ngày. Hãy khiến mọi người nghi ngờ bạn, nhưng đừng để bị giết vào ban đêm.'
        }
    ];

    const byId = Object.freeze(Object.fromEntries(roles.map(role => [role.id, Object.freeze({ ...role })])));
    const bySettingsKey = Object.freeze(Object.fromEntries(roles.map(role => [role.settingsKey, byId[role.id]])));

    function get(roleId) {
        return byId[roleId] || null;
    }

    function list() {
        return roles.map(role => byId[role.id]);
    }

    function settingKeys() {
        return roles.map(role => role.settingsKey);
    }

    function isWolfRole(roleId) {
        return !!(get(roleId) && get(roleId).isWolfRole);
    }

    function hasNightAction(roleId) {
        return !!(get(roleId) && get(roleId).hasNightAction);
    }

    function alignmentOf(roleId) {
        return get(roleId)?.alignment || 'UNKNOWN';
    }

    function idsBy(predicate) {
        return roles.filter(predicate).map(role => role.id);
    }

    return Object.freeze({
        roles: Object.freeze(roles.map(role => byId[role.id])),
        byId,
        bySettingsKey,
        get,
        list,
        settingKeys,
        isWolfRole,
        hasNightAction,
        alignmentOf,
        idsBy,
        wolfRoleIds: Object.freeze(idsBy(role => role.isWolfRole)),
        goodRoleIds: Object.freeze(idsBy(role => role.alignment === 'GOOD')),
        evilRoleIds: Object.freeze(idsBy(role => role.alignment === 'EVIL')),
        unknownRoleIds: Object.freeze(idsBy(role => role.alignment === 'UNKNOWN'))
    });
});
