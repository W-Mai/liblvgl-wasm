use lvw_feature_validator::{FEATURES, POLICY_VERSION};
use std::collections::BTreeSet;

fn main() {
    let mut names = BTreeSet::new();
    let mut masks = 0u32;
    print!("{{\"policyVersion\":{POLICY_VERSION},\"features\":[");
    for (index, feature) in FEATURES.iter().enumerate() {
        assert!(!feature.name.is_empty());
        assert!(
            feature
                .name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        );
        assert!(names.insert(feature.name));
        assert!(feature.mask.is_power_of_two() && masks & feature.mask == 0);
        masks |= feature.mask;
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"name\":\"{}\",\"mask\":{}}}",
            feature.name, feature.mask
        );
    }
    println!("]}}");
}
